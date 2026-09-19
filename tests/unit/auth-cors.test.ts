import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/app.js'
import { installFetchMock, jsonResponse } from '../helpers/mock.js'

const app = createApp()

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('鉴权中间件', () => {
  it('缺少 Authorization 头返回 401 且给出 Bearer 提示', async () => {
    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'agnes-3.0-flash', messages: [] })
    })
    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toBe('Bearer')
    const body = await response.json()
    expect(body.error.type).toBe('authentication_error')
  })

  it('x-api-key 不被接受', async () => {
    const response = await app.request('/v1/models', { headers: { 'x-api-key': 'sk-fixture-x-api-key' } })
    expect(response.status).toBe(401)
  })

  it('非 Bearer 形式返回 401', async () => {
    const response = await app.request('/v1/models', { headers: { authorization: 'Token abc' } })
    expect(response.status).toBe(401)
  })

  it('响应体不包含请求中的密钥', async () => {
    const secret = 'sk-fixture-super-secret-value'
    const mock = installFetchMock(() => jsonResponse({ data: [] }))
    const response = await app.request('/v1/models', { headers: { authorization: `Bearer ${secret}` } })
    const text = await response.text()
    expect(mock.calls[0]!.headers.authorization).toBe(`Bearer ${secret}`)
    expect(text).not.toContain(secret)
  })

  it('未适配模型的透传请求也会带上 Authorization', async () => {
    const mock = installFetchMock(() => jsonResponse({ ok: true }))
    await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer sk-test', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'agnes-2.5-pro', messages: [] })
    })
    expect(mock.calls[0]!.headers.authorization).toBe('Bearer sk-test')
  })
})

describe('CORS', () => {
  it('预检请求返回 204 与完整跨域头', async () => {
    const response = await app.request('/v1/chat/completions', {
      method: 'OPTIONS',
      headers: {
        origin: 'https://example.com',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type'
      }
    })
    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect(response.headers.get('access-control-allow-methods')).toContain('POST')
    expect(response.headers.get('access-control-allow-headers')?.toLowerCase()).toContain('authorization')
  })

  it('未知路径的预检同样返回 204', async () => {
    const response = await app.request('/v1/unknown/path', { method: 'OPTIONS', headers: { origin: 'https://example.com' } })
    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
  })

  it('普通响应也带跨域头，首页不需要鉴权', async () => {
    const response = await app.request('/', { headers: { origin: 'https://example.com' } })
    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(await response.text()).toContain('Agnes OpenAI 兼容网关')
  })

  it('未知的非 /v1 路径返回 404', async () => {
    const response = await app.request('/nope')
    expect(response.status).toBe(404)
    const body = await response.json()
    expect(body.error.code).toBe('not_found')
  })
})
