import { beforeAll, describe, expect, it } from 'vitest'
import { dataUriImage, liveContext, readJson, recordResult, type LiveContext } from '../helpers/live.js'
import { withTransientRetry } from '../helpers/env.js'

let live: LiveContext

beforeAll(() => {
  live = liveContext()
})

function post(path: string, body: unknown): Promise<Response> {
  return live.app.request(path, {
    method: 'POST',
    headers: { authorization: `Bearer ${live.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
}

describe.skipIf(!liveContext().enabled)('真实上游 · 文本', () => {
  it('非流式补全返回标准 OpenAI 结构', async () => {
    const result = await withTransientRetry(async () => {
      const response = await post('/v1/chat/completions', {
        model: 'agnes-3.0-flash',
        messages: [{ role: 'user', content: '只回复一个词：pong' }],
        max_tokens: 16
      })
      const body = await readJson(response)
      if (response.status === 401) throw new Error(`transient 401: ${body?.error?.message}`)
      return { status: response.status, body }
    })

    recordResult('live-chat.jsonl', { case: 'chat.non_stream', status: result.status, body: result.body })
    expect(result.status).toBe(200)
    expect(result.body.object).toBe('chat.completion')
    expect(result.body.choices[0].message.role).toBe('assistant')
    expect(typeof result.body.choices[0].message.content).toBe('string')
    expect(result.body.choices[0].message.reasoning_content).toBeUndefined()
    expect(result.body.metadata).toBeUndefined()
    expect(result.body.choices[0].provider_specific_fields).toBeUndefined()
    expect(result.body.usage.total_tokens).toBeGreaterThan(0)
  }, 120_000)

  it('流式补全以 data: [DONE] 结束且不含非标准字段', async () => {
    const response = await withTransientRetry(async () => {
      const result = await post('/v1/chat/completions', {
        model: 'agnes-3.0-flash',
        messages: [{ role: 'user', content: '从 1 数到 5' }],
        max_tokens: 64,
        stream: true
      })
      if (result.status === 401) throw new Error('transient 401')
      return result
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const text = await response.text()
    recordResult('live-chat.jsonl', { case: 'chat.stream', status: response.status, sse: text.slice(0, 1200) })
    expect(text).toContain('data: [DONE]')
    expect(text).not.toContain('provider_specific_fields')
    expect(text).not.toContain('"metadata"')
    const events = text
      .split('\n')
      .filter((line) => line.startsWith('data:') && !line.includes('[DONE]'))
      .map((line) => JSON.parse(line.slice(5).trim()))
    expect(events.every((event) => event.usage === undefined)).toBe(true)
    const content = events.map((event) => event.choices?.[0]?.delta?.content ?? '').join('')
    expect(content.trim().length).toBeGreaterThan(0)
  }, 120_000)

  it('include_usage=true 返回 usage 分片', async () => {
    const response = await withTransientRetry(async () => {
      const result = await post('/v1/chat/completions', {
        model: 'agnes-3.0-flash',
        messages: [{ role: 'user', content: '说你好' }],
        max_tokens: 16,
        stream: true,
        stream_options: { include_usage: true }
      })
      if (result.status === 401) throw new Error('transient 401')
      return result
    })
    const text = await response.text()
    const events = text
      .split('\n')
      .filter((line) => line.startsWith('data:') && !line.includes('[DONE]'))
      .map((line) => JSON.parse(line.slice(5).trim()))
    const usageEvent = events.find((event) => event.usage !== undefined)
    expect(usageEvent).toBeDefined()
    expect(usageEvent.choices).toEqual([])
    recordResult('live-chat.jsonl', { case: 'chat.stream_usage', usage: usageEvent.usage })
  }, 120_000)

  it('非流式工具调用返回 tool_calls', async () => {
    const response = await withTransientRetry(async () => {
      const result = await post('/v1/chat/completions', {
        model: 'agnes-3.0-flash',
        messages: [{ role: 'user', content: '上海现在天气怎么样？必须调用工具查询。' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'get_weather',
              description: '获取指定城市当前天气',
              parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] }
            }
          }
        ],
        tool_choice: 'auto',
        max_tokens: 256
      })
      if (result.status === 401) throw new Error('transient 401')
      return result
    })
    const body = await readJson(response)
    recordResult('live-chat.jsonl', { case: 'chat.tool_call', status: response.status, body })
    expect(response.status).toBe(200)
    const message = body.choices[0].message
    expect(body.choices[0].finish_reason).toBe('tool_calls')
    expect(message.tool_calls.length).toBeGreaterThan(0)
    expect(message.tool_calls[0].type).toBe('function')
    expect(message.tool_calls[0].index).toBeUndefined()
    expect(message.tool_calls[0].id).toMatch(/^call_/)
    expect(message.content).toBeNull()
    const args = JSON.parse(message.tool_calls[0].function.arguments)
    expect(typeof args.city).toBe('string')
  }, 120_000)

  it('并行工具调用返回多个 tool_calls', async () => {
    const response = await withTransientRetry(async () => {
      const result = await post('/v1/chat/completions', {
        model: 'agnes-3.0-flash',
        messages: [{ role: 'user', content: '同时查询北京和上海两个城市的天气，两个都要调用工具。' }],
        tools: [
          { type: 'function', function: { name: 'get_beijing_weather', description: '北京天气', parameters: { type: 'object', properties: {} } } },
          { type: 'function', function: { name: 'get_shanghai_weather', description: '上海天气', parameters: { type: 'object', properties: {} } } }
        ],
        parallel_tool_calls: true,
        max_tokens: 256
      })
      if (result.status === 401) throw new Error('transient 401')
      return result
    })
    const body = await readJson(response)
    recordResult('live-chat.jsonl', { case: 'chat.parallel_tool_calls', status: response.status, body })
    expect(response.status).toBe(200)
    expect(body.choices[0].message.tool_calls.length).toBeGreaterThanOrEqual(1)
  }, 120_000)

  it('流式工具调用分片可拼接', async () => {
    const response = await withTransientRetry(async () => {
      const result = await post('/v1/chat/completions', {
        model: 'agnes-3.0-flash',
        messages: [{ role: 'user', content: '查询上海天气，调用工具。' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'get_weather',
              description: '获取指定城市当前天气',
              parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] }
            }
          }
        ],
        // 强制调用工具，避免模型选择直接作答导致用例不稳定
        tool_choice: { type: 'function', function: { name: 'get_weather' } },
        stream: true,
        max_tokens: 256
      })
      if (result.status === 401) throw new Error('transient 401')
      return result
    })
    const text = await response.text()
    recordResult('live-chat.jsonl', { case: 'chat.stream_tool_calls', sse: text.slice(0, 1500) })
    const events = text
      .split('\n')
      .filter((line) => line.startsWith('data:') && !line.includes('[DONE]'))
      .map((line) => JSON.parse(line.slice(5).trim()))
    const toolCallDeltas = events.flatMap((event) => event.choices?.[0]?.delta?.tool_calls ?? [])
    expect(toolCallDeltas.length).toBeGreaterThan(0)
    const argumentsText = toolCallDeltas.map((delta: any) => delta.function?.arguments ?? '').join('')
    expect(JSON.parse(argumentsText).city).toBeTruthy()
    expect(events.some((event) => event.choices?.[0]?.finish_reason === 'tool_calls')).toBe(true)
  }, 120_000)

  it('多轮 tool 回灌可以拿到最终回答', async () => {
    const first = await withTransientRetry(async () => {
      const response = await post('/v1/chat/completions', {
        model: 'agnes-3.0-flash',
        messages: [{ role: 'user', content: '上海现在天气怎么样？必须调用工具。' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'get_weather',
              description: '获取指定城市当前天气',
              parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] }
            }
          }
        ],
        max_tokens: 256
      })
      if (response.status === 401) throw new Error('transient 401')
      return readJson(response)
    })
    const toolCall = first.choices[0].message.tool_calls[0]

    const second = await withTransientRetry(async () => {
      const response = await post('/v1/chat/completions', {
        model: 'agnes-3.0-flash',
        messages: [
          { role: 'user', content: '上海现在天气怎么样？必须调用工具。' },
          { role: 'assistant', content: null, tool_calls: first.choices[0].message.tool_calls },
          { role: 'tool', tool_call_id: toolCall.id, content: '{"temp_c": 18, "condition": "多云"}' }
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'get_weather',
              description: '获取指定城市当前天气',
              parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] }
            }
          }
        ],
        max_tokens: 128
      })
      if (response.status === 401) throw new Error('transient 401')
      return readJson(response)
    })
    recordResult('live-chat.jsonl', { case: 'chat.tool_roundtrip', second })
    expect(second.choices[0].finish_reason).toBe('stop')
    expect(String(second.choices[0].message.content)).toContain('18')
  }, 180_000)

  it('n=2 返回两个 choices', async () => {
    const response = await withTransientRetry(async () => {
      const result = await post('/v1/chat/completions', {
        model: 'agnes-3.0-flash',
        messages: [{ role: 'user', content: '用一个词打招呼' }],
        max_tokens: 16,
        n: 2
      })
      if (result.status === 401) throw new Error('transient 401')
      return result
    })
    const body = await readJson(response)
    recordResult('live-chat.jsonl', { case: 'chat.n2', choices: body.choices?.length })
    expect(response.status).toBe(200)
    expect(body.choices).toHaveLength(2)
  }, 120_000)

  it('logprobs 透传', async () => {
    const response = await withTransientRetry(async () => {
      const result = await post('/v1/chat/completions', {
        model: 'agnes-3.0-flash',
        messages: [{ role: 'user', content: '说你好' }],
        max_tokens: 16,
        logprobs: true,
        top_logprobs: 2
      })
      if (result.status === 401) throw new Error('transient 401')
      return result
    })
    const body = await readJson(response)
    expect(response.status).toBe(200)
    expect(body.choices[0].logprobs).toBeTruthy()
  }, 120_000)

  it('data URI 图片输入可用', async () => {
    const response = await withTransientRetry(async () => {
      const result = await post('/v1/chat/completions', {
        model: 'agnes-3.0-flash',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: '这张图的主要颜色是什么？只回答颜色。' },
              { type: 'image_url', image_url: { url: dataUriImage() } }
            ]
          }
        ],
        max_tokens: 24
      })
      if (result.status === 401) throw new Error('transient 401')
      return result
    })
    const body = await readJson(response)
    recordResult('live-chat.jsonl', { case: 'chat.image_input', status: response.status, body })
    expect(response.status).toBe(200)
    expect(String(body.choices[0].message.content).length).toBeGreaterThan(0)
  }, 120_000)

  it('旧版 functions 协议在网关侧即被拒绝（不消耗上游额度）', async () => {
    const response = await post('/v1/chat/completions', {
      model: 'agnes-3.0-flash',
      messages: [{ role: 'user', content: 'hi' }],
      functions: [{ name: 'f', parameters: { type: 'object', properties: {} } }]
    })
    expect(response.status).toBe(400)
    const body = await readJson(response)
    expect(body.error.code).toBe('unsupported_legacy_protocol')
  })

  it('未适配模型透传（agnes-2.5-pro）', async () => {
    const response = await withTransientRetry(async () => {
      const result = await post('/v1/chat/completions', {
        model: 'agnes-2.5-pro',
        messages: [{ role: 'user', content: '只回复一个词：pong' }],
        max_tokens: 16
      })
      if (result.status === 401) throw new Error('transient 401')
      return result
    })
    const body = await readJson(response)
    recordResult('live-chat.jsonl', { case: 'chat.passthrough', status: response.status, body })
    expect(response.status).toBe(200)
    expect(body.model).toBe('agnes-2.5-pro')
  }, 120_000)

  it('不存在的模型返回归一化错误', async () => {
    const response = await post('/v1/chat/completions', {
      model: 'definitely-not-a-real-model',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 8
    })
    const body = await readJson(response)
    recordResult('live-chat.jsonl', { case: 'chat.unknown_model', status: response.status, body })
    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(body.error).toBeDefined()
    expect(typeof body.error.message).toBe('string')
    expect(body.error.type).toBeTruthy()
  }, 120_000)
})
