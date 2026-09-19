import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/app.js'
import { installFetchMock, jsonResponse, sseResponse } from '../helpers/mock.js'

const app = createApp()

afterEach(() => {
  vi.unstubAllGlobals()
})

function chat(body: Record<string, unknown>) {
  return app.request('/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer sk-test', 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
}

function upstreamChunk(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

function parseEvents(text: string): Array<any | '[DONE]'> {
  return text
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => {
      const payload = line.slice(5).trim()
      return payload === '[DONE]' ? ('[DONE]' as const) : JSON.parse(payload)
    })
}

const contentChunks = [
  upstreamChunk({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'agnes-3.0-flash', choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] }),
  upstreamChunk({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'agnes-3.0-flash', choices: [{ index: 0, delta: { content: '你好' } }] }),
  upstreamChunk({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'agnes-3.0-flash', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
  upstreamChunk({
    id: 'c1',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'agnes-3.0-flash',
    choices: [{ index: 0, delta: {} }],
    usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }
  }),
  'data: [DONE]\n\n'
]

describe('流式响应规范化', () => {
  it('默认不返回 usage 分片，并保留 [DONE]', async () => {
    installFetchMock(() => sseResponse(contentChunks))
    const response = await chat({ model: 'agnes-3.0-flash', messages: [{ role: 'user', content: 'hi' }], stream: true })
    expect(response.headers.get('content-type')).toContain('text/event-stream')

    const events = parseEvents(await response.text())
    expect(events.at(-1)).toBe('[DONE]')
    expect(events.filter((event) => event !== '[DONE]')).toHaveLength(3)
    expect(events.some((event) => event !== '[DONE]' && event.usage !== undefined)).toBe(false)
  })

  it('include_usage=true 时下发 choices: [] 的 usage 分片', async () => {
    installFetchMock(() => sseResponse(contentChunks))
    const response = await chat({
      model: 'agnes-3.0-flash',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      stream_options: { include_usage: true }
    })
    const events = parseEvents(await response.text())
    const usageEvent = events.find((event) => event !== '[DONE]' && event.usage !== undefined)
    expect(usageEvent.choices).toEqual([])
    expect(usageEvent.usage.total_tokens).toBe(7)
    expect(events.at(-1)).toBe('[DONE]')
  })

  it('剥离 reasoning_content 与 provider_specific_fields', async () => {
    installFetchMock(() =>
      sseResponse([
        upstreamChunk({
          id: 'c1',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'agnes-3.0-flash',
          choices: [{ index: 0, delta: { role: 'assistant', content: 'hi', reasoning_content: 'secret' }, provider_specific_fields: { matched_stop: null } }],
          metadata: { weight_version: 'default' }
        }),
        'data: [DONE]\n\n'
      ])
    )
    const response = await chat({ model: 'agnes-3.0-flash', messages: [{ role: 'user', content: 'hi' }], stream: true })
    const text = await response.text()
    expect(text).not.toContain('reasoning_content')
    expect(text).not.toContain('provider_specific_fields')
    expect(text).not.toContain('metadata')
    const events = parseEvents(text)
    expect(events[0].choices[0].delta).toEqual({ role: 'assistant', content: 'hi' })
  })

  it('保留流式工具调用的分片与 index', async () => {
    installFetchMock(() =>
      sseResponse([
        upstreamChunk({
          id: 'c1',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'agnes-3.0-flash',
          choices: [{ index: 0, delta: { tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'get_weather', arguments: '' }, index: 0 }] } }]
        }),
        upstreamChunk({
          id: 'c1',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'agnes-3.0-flash',
          choices: [{ index: 0, delta: { tool_calls: [{ function: { arguments: '{"city":"上海"}' }, type: 'function', index: 0 }] } }]
        }),
        upstreamChunk({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'agnes-3.0-flash', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
        'data: [DONE]\n\n'
      ])
    )
    const response = await chat({
      model: 'agnes-3.0-flash',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: {} } } }],
      stream: true
    })
    const events = parseEvents(await response.text())
    expect(events[0].choices[0].delta.tool_calls[0]).toEqual({
      id: 'call_a',
      type: 'function',
      function: { name: 'get_weather', arguments: '' },
      index: 0
    })
    expect(events[1].choices[0].delta.tool_calls[0].function.arguments).toBe('{"city":"上海"}')
    expect(events[2].choices[0].finish_reason).toBe('tool_calls')
  })

  it('分片跨 TCP 边界时仍能正确解析', async () => {
    const encoder = new TextEncoder()
    const full = contentChunks.join('')
    const parts = [full.slice(0, 40), full.slice(40, 120), full.slice(120)]
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of parts) controller.enqueue(encoder.encode(part))
        controller.close()
      }
    })
    installFetchMock(() => new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }))
    const response = await chat({ model: 'agnes-3.0-flash', messages: [], stream: true })
    const events = parseEvents(await response.text())
    expect(events.at(-1)).toBe('[DONE]')
    expect(events.filter((event) => event !== '[DONE]')).toHaveLength(3)
  })

  it('上游错误响应在流式请求下仍然归一化', async () => {
    installFetchMock(() => jsonResponse({ error: { message: 'bad model', code: 'model_not_found' } }, 503))
    const response = await chat({ model: 'agnes-3.0-flash', messages: [], stream: true })
    expect(response.status).toBe(503)
    const body = await response.json()
    expect(body.error.type).toBe('api_error')
    expect(body.error.message).toBe('bad model')
    expect(body.error.code).toBe('model_not_found')
  })
})

describe('透传模型的流式响应', () => {
  it('未适配模型逐字节透传 SSE', async () => {
    installFetchMock(() => sseResponse(['data: {"weird":true}\n\n', 'data: [DONE]\n\n']))
    const response = await chat({ model: 'agnes-2.5-pro', messages: [], stream: true })
    const text = await response.text()
    expect(text).toBe('data: {"weird":true}\n\ndata: [DONE]\n\n')
    expect(response.headers.get('content-type')).toContain('text/event-stream')
  })
})
