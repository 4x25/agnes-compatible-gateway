import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/app.js'
import { parseDynamicBase } from '../../src/lib/dynamic-base.js'
import { resolveUpstreamConfig } from '../../src/lib/config.js'
import { installFetchMock, jsonResponse, sseResponse } from '../helpers/mock.js'

const app = createApp()

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('动态 baseUrl 解析', () => {
  it('从路径中提取上游 base 与网关端点', () => {
    expect(parseDynamicBase('/https://upstream.example.com/v1/chat/completions')).toEqual({
      baseUrl: 'https://upstream.example.com/v1',
      routePath: '/v1/chat/completions',
      videoId: undefined
    })
  })

  it('兼容 CDN 把 // 折叠成 / 的写法', () => {
    const match = parseDynamicBase('/https:/upstream.example.com/v1/images/generations')
    expect(match?.baseUrl).toBe('https://upstream.example.com/v1')
    expect(match?.routePath).toBe('/v1/images/generations')
  })

  it('动态 base 不含 /v1 时端点前保留全部前缀', () => {
    expect(parseDynamicBase('/https://upstream.example.com/agnes/chat/completions')?.baseUrl).toBe('https://upstream.example.com/agnes')
  })

  it('捕获视频查询与下载的 video_id', () => {
    expect(parseDynamicBase('/https://upstream.example.com/v1/videos/agnes-video-2.5-flash%3Atask_1')).toMatchObject({
      baseUrl: 'https://upstream.example.com/v1',
      routePath: '/v1/videos/:video_id',
      videoId: 'agnes-video-2.5-flash%3Atask_1'
    })
    expect(parseDynamicBase('/https://upstream.example.com/v1/videos/video_1/content')).toMatchObject({
      routePath: '/v1/videos/:video_id/content',
      videoId: 'video_1'
    })
  })

  it('非动态或非法输入返回 null', () => {
    expect(parseDynamicBase('/v1/chat/completions')).toBeNull()
    expect(parseDynamicBase('/https://upstream.example.com/v1/unknown')).toBeNull()
    expect(parseDynamicBase('/https://upstream.example.com')).toBeNull()
    expect(parseDynamicBase('/https:///')).toBeNull()
    expect(parseDynamicBase('/ftp://upstream.example.com/v1/chat/completions')).toBeNull()
  })
})

describe('动态 baseUrl 覆盖环境变量', () => {
  it('动态值优先于 AGNES_BASE_URL', () => {
    const config = resolveUpstreamConfig({ AGNES_BASE_URL: 'https://env.test/v1' }, 'https://dynamic.test/v1')
    expect(config.baseUrl).toBe('https://dynamic.test/v1')
    expect(config.queryUrl).toBe('https://dynamic.test/agnesapi')
  })

  it('动态值为空白时回落到环境变量', () => {
    expect(resolveUpstreamConfig({ AGNES_BASE_URL: 'https://env.test/v1' }, '   ').baseUrl).toBe('https://env.test/v1')
  })
})

describe('动态 baseUrl 请求转发', () => {
  const auth = { authorization: 'Bearer sk-test', 'content-type': 'application/json' }

  it('透传请求打到路径中指定的上游', async () => {
    const mock = installFetchMock(() => jsonResponse({ ok: true }))
    const response = await app.request('/https://other-upstream.test/v1/chat/completions', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ model: 'agnes-2.5-pro', messages: [] })
    })
    expect(response.status).toBe(200)
    expect(mock.calls[0]!.url).toBe('https://other-upstream.test/v1/chat/completions')
    expect(mock.calls[0]!.headers.authorization).toBe('Bearer sk-test')
  })

  it('CDN 折叠 // 后仍转发到正确上游', async () => {
    const mock = installFetchMock(() => jsonResponse({ ok: true }))
    await app.request('/https:/other-upstream.test/v1/models', { headers: { authorization: 'Bearer sk-test' } })
    expect(mock.calls[0]!.url).toBe('https://other-upstream.test/v1/models')
  })

  it('适配模型走同一套适配逻辑，仅替换上游', async () => {
    const mock = installFetchMock(() => jsonResponse({ id: 'x', choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }] }))
    const response = await app.request('/https://other-upstream.test/v1/chat/completions', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ model: 'agnes-3.0-flash', messages: [{ role: 'user', content: 'hi' }] })
    })
    expect(response.status).toBe(200)
    expect(mock.calls[0]!.url).toBe('https://other-upstream.test/v1/chat/completions')
  })

  it('动态路径下的流式对话仍正常归一化', async () => {
    installFetchMock(() =>
      sseResponse([
        `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'agnes-3.0-flash', choices: [{ index: 0, delta: { content: 'hi' } }] })}\n\n`,
        'data: [DONE]\n\n'
      ])
    )
    const response = await app.request('/https://other-upstream.test/v1/chat/completions', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ model: 'agnes-3.0-flash', messages: [{ role: 'user', content: 'hi' }], stream: true })
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const text = await response.text()
    expect(text).toContain('data: ')
    expect(text).toContain('[DONE]')
  })

  it('视频查询使用动态 base 推导的 agnesapi 地址', async () => {
    const mock = installFetchMock(() => jsonResponse({ video_id: 'video_1', status: 'in_progress', progress: 10 }))
    await app.request('/https:/other-upstream.test/v1/videos/agnes-video-2.5-flash%3Avideo_1', {
      headers: { authorization: 'Bearer sk-test' }
    })
    expect(mock.calls[0]!.url).toBe('https://other-upstream.test/agnesapi?video_id=video_1&model_name=agnes-video-2.5-flash')
  })

  it('动态路径同样要求 Bearer 鉴权', async () => {
    const response = await app.request('/https://other-upstream.test/v1/models')
    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toBe('Bearer')
  })

  it('动态前缀下未知端点返回 404', async () => {
    const response = await app.request('/https://other-upstream.test/v1/unknown', { headers: { authorization: 'Bearer sk-test' } })
    expect(response.status).toBe(404)
    expect((await response.json()).error.code).toBe('not_found')
  })
})
