import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/app.js'
import { installFetchMock, jsonResponse, proxyBaseUrl } from '../helpers/mock.js'

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

describe('工具调用请求适配', () => {
  it('functions 被明确拒绝并给出改写指引', async () => {
    const mock = installFetchMock(() => jsonResponse({}))
    const response = await chat({
      model: 'agnes-3.0-flash',
      messages: [{ role: 'user', content: 'hi' }],
      functions: [{ name: 'f', parameters: { type: 'object', properties: {} } }]
    })
    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.error.type).toBe('invalid_request_error')
    expect(body.error.code).toBe('unsupported_legacy_protocol')
    expect(body.error.message).toContain('tools')
    expect(body.error.message).toContain('tool_choice')
    expect(mock.calls).toHaveLength(0)
  })

  it('function_call 字符串形式被拒绝', async () => {
    const mock = installFetchMock(() => jsonResponse({}))
    const response = await chat({ model: 'agnes-3.0-flash', messages: [], function_call: 'auto' })
    expect(response.status).toBe(400)
    expect((await response.json()).error.param).toBe('function_call')
    expect(mock.calls).toHaveLength(0)
  })

  it('function_call 对象形式同样被拒绝', async () => {
    const mock = installFetchMock(() => jsonResponse({}))
    const response = await chat({ model: 'agnes-3.0-flash', messages: [], function_call: { name: 'f' } })
    expect(response.status).toBe(400)
    expect(mock.calls).toHaveLength(0)
  })

  it('空的 functions 数组不触发 400', async () => {
    const mock = installFetchMock(() => jsonResponse({ id: 'x', object: 'chat.completion', created: 1, model: 'agnes-3.0-flash', choices: [] }))
    const response = await chat({ model: 'agnes-3.0-flash', messages: [{ role: 'user', content: 'hi' }], functions: [] })
    expect(response.status).toBe(200)
    expect(mock.calls).toHaveLength(1)
  })

  it('缺失 function.parameters 时补上空的 object schema', async () => {
    const mock = installFetchMock(() =>
      jsonResponse({ id: 'x', object: 'chat.completion', created: 1, model: 'agnes-3.0-flash', choices: [] })
    )
    const response = await chat({
      model: 'agnes-3.0-flash',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'get_weather', description: 'd' } }]
    })
    expect(response.status).toBe(200)
    expect(mock.calls[0]!.body.tools[0].function.parameters).toEqual({ type: 'object', properties: {} })
  })

  it('已提供的 parameters 与 strict 原样保留', async () => {
    const mock = installFetchMock(() =>
      jsonResponse({ id: 'x', object: 'chat.completion', created: 1, model: 'agnes-3.0-flash', choices: [] })
    )
    const parameters = { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false }
    await chat({
      model: 'agnes-3.0-flash',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'get_weather', parameters, strict: true } }],
      tool_choice: 'required',
      parallel_tool_calls: true
    })
    const sent = mock.calls[0]!.body
    expect(sent.tools[0].function.parameters).toEqual(parameters)
    expect(sent.tools[0].function.strict).toBe(true)
    expect(sent.tool_choice).toBe('required')
    expect(sent.parallel_tool_calls).toBe(true)
  })

  it('非 function 类型的工具返回清晰 400', async () => {
    const mock = installFetchMock(() => jsonResponse({}))
    const response = await chat({ model: 'agnes-3.0-flash', messages: [], tools: [{ type: 'custom', custom: { name: 'x' } }] })
    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.error.code).toBe('unsupported_tool_type')
    expect(body.error.message).toContain('function')
    expect(mock.calls).toHaveLength(0)
  })

  it('tool_choice 缺少 tools 时返回 400', async () => {
    const mock = installFetchMock(() => jsonResponse({}))
    const response = await chat({ model: 'agnes-3.0-flash', messages: [], tool_choice: 'auto' })
    expect(response.status).toBe(400)
    expect((await response.json()).error.code).toBe('invalid_tool_choice')
    expect(mock.calls).toHaveLength(0)
  })

  it('具名 tool_choice 透传给上游', async () => {
    const mock = installFetchMock(() =>
      jsonResponse({ id: 'x', object: 'chat.completion', created: 1, model: 'agnes-3.0-flash', choices: [] })
    )
    await chat({
      model: 'agnes-3.0-flash',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: {} } } }],
      tool_choice: { type: 'function', function: { name: 'get_weather' } }
    })
    expect(mock.calls[0]!.body.tool_choice).toEqual({ type: 'function', function: { name: 'get_weather' } })
  })

  it('旧版 role: "function" 消息仍可透传（上游支持）', async () => {
    const mock = installFetchMock(() =>
      jsonResponse({ id: 'x', object: 'chat.completion', created: 1, model: 'agnes-3.0-flash', choices: [] })
    )
    const response = await chat({
      model: 'agnes-3.0-flash',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'function', name: 'f', content: 'result' }
      ]
    })
    expect(response.status).toBe(200)
    expect(mock.calls[0]!.body.messages).toHaveLength(2)
  })

  it('多轮 tool 回灌请求体保持 tool_call_id', async () => {
    const mock = installFetchMock(() =>
      jsonResponse({ id: 'x', object: 'chat.completion', created: 1, model: 'agnes-3.0-flash', choices: [] })
    )
    await chat({
      model: 'agnes-3.0-flash',
      messages: [
        { role: 'user', content: 'weather?' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'call_1', content: '18C' }
      ],
      tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: {} } } }]
    })
    const messages = mock.calls[0]!.body.messages
    expect(messages[1].tool_calls[0].id).toBe('call_1')
    expect(messages[2].tool_call_id).toBe('call_1')
  })
})

describe('工具调用响应规范化', () => {
  const upstreamToolCall = {
    id: 'chatcmpl_1',
    object: 'chat.completion',
    created: 123,
    model: 'agnes-3.0-flash',
    choices: [
      {
        index: 0,
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: '',
          reasoning_content: 'thinking hard',
          tool_calls: [
            { index: 0, id: 'call_a', type: 'function', function: { name: 'get_weather', arguments: '{"city":"上海"}' } },
            { index: 1, id: 'call_b', type: 'function', function: { name: 'get_time', arguments: '{}' } }
          ]
        },
        provider_specific_fields: { matched_stop: null }
      }
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    metadata: { weight_version: 'default' }
  }

  it('非流式：去 index/元数据，content 空串变 null，保留并行调用', async () => {
    installFetchMock(() => jsonResponse(upstreamToolCall))
    const response = await chat({ model: 'agnes-3.0-flash', messages: [{ role: 'user', content: 'hi' }] })
    const body = await response.json()

    expect(body.metadata).toBeUndefined()
    expect(body.choices[0].provider_specific_fields).toBeUndefined()
    expect(body.choices[0].message.reasoning_content).toBeUndefined()
    expect(body.choices[0].message.content).toBeNull()
    expect(body.choices[0].message.tool_calls).toHaveLength(2)
    expect(body.choices[0].message.tool_calls[0].index).toBeUndefined()
    expect(body.choices[0].message.tool_calls[1].function.name).toBe('get_time')
    expect(body.choices[0].finish_reason).toBe('tool_calls')
    expect(body.usage.total_tokens).toBe(15)
    expect(body.object).toBe('chat.completion')
  })

  it('非流式：reasoning_content 不会出现在响应里', async () => {
    installFetchMock(() => jsonResponse(upstreamToolCall))
    const response = await chat({ model: 'agnes-3.0-flash', messages: [{ role: 'user', content: 'hi' }] })
    expect(await response.text()).not.toContain('reasoning_content')
  })
})

describe('上游请求转发的模型选择', () => {
  it('适配模型使用 chat/completions 上游路径', async () => {
    const mock = installFetchMock(() => jsonResponse({ id: 'x', object: 'chat.completion', created: 1, model: 'm', choices: [] }))
    await chat({ model: 'agnes-3.0-flash', messages: [] })
    expect(mock.calls[0]!.url).toBe(`${proxyBaseUrl()}/chat/completions`)
    expect(mock.calls[0]!.method).toBe('POST')
  })

  it('未适配模型透传原始 body', async () => {
    const mock = installFetchMock(() => jsonResponse({ id: 'x', object: 'chat.completion', created: 1, model: 'other', choices: [] }))
    const payload = { model: 'agnes-2.5-pro', messages: [{ role: 'user', content: 'hi' }], custom_extension: { a: 1 } }
    await chat(payload)
    expect(mock.calls[0]!.body).toEqual(payload)
  })
})
