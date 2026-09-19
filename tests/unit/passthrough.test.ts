import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/app.js'
import { installFetchMock, jsonResponse, proxyBaseUrl } from '../helpers/mock.js'

const app = createApp()

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('未适配模型的透传', () => {
  it('GET /v1/models 透传上游响应', async () => {
    const payload = { object: 'list', data: [{ id: 'agnes-3.0-flash', object: 'model', owned_by: 'custom' }] }
    const mock = installFetchMock(() => jsonResponse(payload))
    const response = await app.request('/v1/models', { headers: { authorization: 'Bearer sk-test' } })
    expect(response.status).toBe(200)
    expect(mock.calls[0]!.url).toBe(`${proxyBaseUrl()}/models`)
    expect(mock.calls[0]!.method).toBe('GET')
    expect(await response.json()).toEqual(payload)
  })

  it('图像等 JSON 透传保持上游原始字段（不做归一化）', async () => {
    const payload = { created: 1, data: [{ url: 'https://cdn.test/a.png', b64_json: '', revised_prompt: '' }], task_id: 'task_9' }
    installFetchMock(() => jsonResponse(payload))
    const response = await app.request('/v1/images/generations', {
      method: 'POST',
      headers: { authorization: 'Bearer sk-test', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'agnes-image-2.1-flash', prompt: 'x' })
    })
    expect(await response.json()).toEqual(payload)
  })

  it('透传请求的 body 逐字节保持原始 JSON', async () => {
    const mock = installFetchMock(() => jsonResponse({ ok: true }))
    const raw = '{"model":"agnes-2.5-pro","messages":[{"role":"user","content":"hi"}],"extra":{"keep":"me"}}'
    await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer sk-test', 'content-type': 'application/json' },
      body: raw
    })
    expect(mock.calls[0]!.rawBody).toBe(raw)
  })

  it('透传模型的上游错误也归一化', async () => {
    installFetchMock(() => jsonResponse({ detail: 'model not found' }, 404))
    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer sk-test', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'agnes-2.5-pro', messages: [] })
    })
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: { message: 'model not found', type: 'invalid_request_error', param: null, code: '' } })
  })
})
