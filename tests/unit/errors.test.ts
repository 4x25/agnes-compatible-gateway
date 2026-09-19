import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/app.js'
import { normalizeUpstreamError } from '../../src/lib/errors.js'
import { installFetchMock, jsonResponse, textResponse } from '../helpers/mock.js'

const app = createApp()

afterEach(() => {
  vi.unstubAllGlobals()
})

function chat(body: Record<string, unknown> = { model: 'agnes-3.0-flash', messages: [{ role: 'user', content: 'hi' }] }) {
  return app.request('/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer sk-test', 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
}

describe('上游错误归一化', () => {
  it('FastAPI 风格 {detail} 被解包', () => {
    const error = normalizeUpstreamError(400, JSON.stringify({ detail: 'size must be 720P' }))
    expect(error.status).toBe(400)
    expect(error.type).toBe('invalid_request_error')
    expect(error.message).toBe('size must be 720P')
  })

  it('OpenAI 风格 {error:{code,message}} 保留 code 与 request id', () => {
    const error = normalizeUpstreamError(
      404,
      JSON.stringify({ error: { code: 404, message: 'task not found (request id: 2026abc)' } })
    )
    expect(error.message).toContain('2026abc')
    expect(error.code).toBe('404')
  })

  it('嵌套 OpenAIException 包装被解包出内层 message', () => {
    const inner = JSON.stringify({ object: 'error', message: 'An exception occurred while loading IMAGE data at index 0', type: 'BadRequestError', param: null, code: 400 })
    const raw = JSON.stringify({ error: { code: '400', message: `***.BadRequestError: OpenAIException - ${inner}`, param: '', type: 'upstream_error' } })
    const error = normalizeUpstreamError(400, raw)
    expect(error.message).toContain('An exception occurred while loading IMAGE data at index 0')
    // 保留上游前缀便于排查，同时去掉冗长的 JSON 包装
    expect(error.message).toContain('BadRequestError')
    expect(error.message).not.toContain('"object":"error"')
  })

  it('非 JSON 错误体原样保留', () => {
    const error = normalizeUpstreamError(502, 'Bad Gateway')
    expect(error.message).toBe('Bad Gateway')
    expect(error.type).toBe('api_error')
  })

  it('空错误体给出兜底文案', () => {
    const error = normalizeUpstreamError(500, '')
    expect(error.message).toContain('empty error response')
  })

  it('状态码到 OpenAI type 的映射', () => {
    expect(normalizeUpstreamError(401, '{}').type).toBe('authentication_error')
    expect(normalizeUpstreamError(403, '{}').type).toBe('authentication_error')
    expect(normalizeUpstreamError(429, '{}').type).toBe('rate_limit_error')
    expect(normalizeUpstreamError(500, '{}').type).toBe('api_error')
    expect(normalizeUpstreamError(422, '{}').type).toBe('invalid_request_error')
  })
})

describe('网关错误响应', () => {
  it('上游 400 保持状态码与错误包络', async () => {
    installFetchMock(() => jsonResponse({ detail: 'size must be 720P' }, 400))
    const response = await chat()
    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body).toEqual({ error: { message: 'size must be 720P', type: 'invalid_request_error', param: null, code: '' } })
  })

  it('上游 503 归一化为 api_error 并保留 code', async () => {
    installFetchMock(() =>
      jsonResponse({ error: { code: 'model_not_found', message: 'No available channel for model x', type: 'AgnesAI_error' } }, 503)
    )
    const response = await chat({ model: 'agnes-3.0-flash', messages: [] })
    expect(response.status).toBe(503)
    const body = await response.json()
    expect(body.error.type).toBe('api_error')
    expect(body.error.code).toBe('model_not_found')
  })

  it('网络异常归一化为 502 upstream_error', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed')
    })
    const response = await chat()
    expect(response.status).toBe(502)
    const body = await response.json()
    expect(body.error.type).toBe('upstream_error')
    expect(body.error.message).toContain('fetch failed')
  })

  it('上游返回非 JSON 内容时归一化为 502', async () => {
    installFetchMock(() => textResponse('<html>oops</html>', 200, 'text/html'))
    const response = await chat()
    expect(response.status).toBe(502)
    expect((await response.json()).error.type).toBe('upstream_error')
  })

  it('客户端请求体不是合法 JSON 时返回 400', async () => {
    const mock = installFetchMock(() => jsonResponse({}))
    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer sk-test', 'content-type': 'application/json' },
      body: '{not json'
    })
    expect(response.status).toBe(400)
    expect((await response.json()).error.type).toBe('invalid_request_error')
    expect(mock.calls).toHaveLength(0)
  })

  it('错误响应不包含请求密钥', async () => {
    installFetchMock(() => jsonResponse({ detail: 'nope' }, 400))
    const secret = 'sk-fixture-secret-xyz'
    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'agnes-3.0-flash', messages: [] })
    })
    expect(await response.text()).not.toContain(secret)
  })
})
