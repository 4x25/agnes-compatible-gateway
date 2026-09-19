import { beforeAll, describe, expect, it } from 'vitest'
import { acceptanceContext, authHeaders, readJson, recordAcceptance, type AcceptanceContext } from '../helpers/acceptance.js'
import { withTransientRetry } from '../helpers/env.js'

let ctx: AcceptanceContext

beforeAll(() => {
  ctx = acceptanceContext()
})

function url(path: string): string {
  return `${ctx.target}${path}`
}

function api(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url(path), { ...init, headers: { ...authHeaders(ctx.apiKey), ...(init.headers ?? {}) } })
}


/**
 * The upstream video queue can be saturated (503 `video_queue_full`) and the shared key is
 * occasionally rate limited (transient 401); both are retried with backoff.
 */
async function createVideoWithRetry(body: Record<string, unknown>, attempts = 8, delayMs = 25_000): Promise<{ status: number; body: any }> {
  let last: { status: number; body: any } = { status: 0, body: null }
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await api('/v1/videos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
    const parsed = await readJson(response)
    last = { status: response.status, body: parsed }
    const retryable =
      response.status === 401 ||
      (response.status === 503 && /queue is full/i.test(String(parsed?.error?.message ?? ''))) ||
      (response.status === 503 && String(parsed?.error?.code ?? '').includes('queue'))
    if (!retryable) return last
    recordAcceptance({ case: 'videos_retry', attempt, status: response.status, body: parsed })
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs))
  }
  return last
}


function uploadedImageCount(form: FormData): number {
  return ['image', 'image[]', 'images'].reduce((total, field) => total + form.getAll(field).filter((entry) => typeof entry !== 'string').length, 0)
}

describe.skipIf(!acceptanceContext().enabled)('正式环境验收', () => {
  it('首页返回中文接口文档页', async () => {
    const response = await fetch(url('/'))
    const html = await response.text()
    recordAcceptance({ case: 'home', status: response.status, content_type: response.headers.get('content-type'), length: html.length })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(html).toContain('Agnes OpenAI 兼容网关')
    expect(html).toContain('/v1/chat/completions')
    expect(html).toContain('/v1/videos')
    // 示例地址按访问来源动态生成，且内联脚本会按 location.host 校正
    expect(html).not.toContain('本网关域名')
    expect(html).not.toMatch(/https?:\/\/https?:\/\//)
    expect(html).toContain(`${ctx.target}/v1/chat/completions`)
    expect(html).toContain('location.host')
  })

  it('CORS 预检返回 204 与通配来源', async () => {
    const response = await fetch(url('/v1/chat/completions'), {
      method: 'OPTIONS',
      headers: {
        origin: 'https://example.com',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type'
      }
    })
    recordAcceptance({
      case: 'cors_preflight',
      status: response.status,
      allow_origin: response.headers.get('access-control-allow-origin')
    })
    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
  })

  it('缺少密钥返回 401', async () => {
    const response = await fetch(url('/v1/chat/completions'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'agnes-3.0-flash', messages: [] })
    })
    const body = await readJson(response)
    recordAcceptance({ case: 'auth_missing', status: response.status, body })
    expect(response.status).toBe(401)
    expect(body.error.type).toBe('authentication_error')
  })

  it('GET /v1/models 包含三个适配模型', async () => {
    const response = await api('/v1/models')
    const body = await readJson(response)
    recordAcceptance({ case: 'models', status: response.status, count: body?.data?.length })
    expect(response.status).toBe(200)
    const ids = (body.data ?? []).map((model: any) => model.id)
    expect(ids).toContain('agnes-3.0-flash')
    expect(ids).toContain('agnes-image-2.5-flash')
    expect(ids).toContain('agnes-video-2.5-flash')
  })

  it('文本：非流式补全', async () => {
    const response = await withTransientRetry(async () => {
      const result = await api('/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'agnes-3.0-flash', messages: [{ role: 'user', content: '只回复一个词：pong' }], max_tokens: 16 })
      })
      if (result.status === 401) throw new Error('transient 401')
      return result
    })
    const body = await readJson(response)
    recordAcceptance({ case: 'chat', status: response.status, body })
    expect(response.status).toBe(200)
    expect(body.choices[0].message.content.length).toBeGreaterThan(0)
  }, 120_000)

  it('文本：流式补全以 [DONE] 结束', async () => {
    const response = await withTransientRetry(async () => {
      const result = await api('/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'agnes-3.0-flash', messages: [{ role: 'user', content: '数到三' }], stream: true, max_tokens: 32 })
      })
      if (result.status === 401) throw new Error('transient 401')
      return result
    })
    const text = await response.text()
    recordAcceptance({ case: 'chat_stream', status: response.status, sse: text.slice(0, 800) })
    expect(response.status).toBe(200)
    expect(text).toContain('data: [DONE]')
    expect(text).not.toContain('provider_specific_fields')
  }, 120_000)

  it('文本：工具调用', async () => {
    const response = await withTransientRetry(async () => {
      const result = await api('/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'agnes-3.0-flash',
          messages: [{ role: 'user', content: '上海天气如何？必须调用工具。' }],
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
          tool_choice: { type: 'function', function: { name: 'get_weather' } },
          max_tokens: 256
        })
      })
      if (result.status === 401) throw new Error('transient 401')
      return result
    })
    const body = await readJson(response)
    recordAcceptance({ case: 'chat_tool_call', status: response.status, body })
    expect(response.status).toBe(200)
    expect(body.choices[0].finish_reason).toBe('tool_calls')
    expect(body.choices[0].message.tool_calls[0].function.name).toBe('get_weather')
    expect(body.choices[0].message.tool_calls[0].index).toBeUndefined()
  }, 180_000)

  it('文本：旧版 functions 协议返回 400', async () => {
    const response = await api('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'agnes-3.0-flash', messages: [{ role: 'user', content: 'hi' }], functions: [{ name: 'f', parameters: {} }] })
    })
    const body = await readJson(response)
    recordAcceptance({ case: 'chat_legacy_400', status: response.status, body })
    expect(response.status).toBe(400)
    expect(body.error.code).toBe('unsupported_legacy_protocol')
  })

  it('视频：Flash 限制返回 400', async () => {
    const response = await api('/v1/videos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'agnes-video-2.5-flash', prompt: 'x', videos: [{ url: 'https://example.com/a.mp4' }] })
    })
    const body = await readJson(response)
    expect(response.status).toBe(400)
    expect(body.error.message).toBe('videos is not supported')
  })

  let generatedImageUrl = ''

  it('图像：缺省 size 生成图片', async () => {
    const response = await withTransientRetry(async () => {
      const result = await api('/v1/images/generations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'agnes-image-2.5-flash', prompt: 'A flat red circle on a white background, minimal design' })
      })
      if (result.status === 401) throw new Error('transient 401')
      return result
    })
    const body = await readJson(response)
    recordAcceptance({ case: 'images', status: response.status, body })
    expect(response.status).toBe(200)
    expect(body.data[0].url).toMatch(/^https?:\/\//)
    generatedImageUrl = body.data[0].url
  }, 300_000)

  it('图像：n=2 扇出返回两张图', async () => {
    const response = await withTransientRetry(async () => {
      const result = await api('/v1/images/generations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'agnes-image-2.5-flash', prompt: 'A flat blue circle on a white background', size: '1K', n: 2 })
      })
      if (result.status === 401) throw new Error('transient 401')
      return result
    })
    const body = await readJson(response)
    recordAcceptance({ case: 'images_n2', status: response.status, urls: body?.data?.map((item: any) => item.url) })
    expect(response.status).toBe(200)
    expect(body.data).toHaveLength(2)
  }, 600_000)

  it('图像编辑：multipart 上传两张真实图片（含 mask 告警头）', async () => {
    if (!generatedImageUrl) throw new Error('前置图像用例未产出可用图片')

    const second = await withTransientRetry(async () => {
      const result = await api('/v1/images/generations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'agnes-image-2.5-flash', prompt: 'A simple yellow square on a white background, flat design' })
      })
      if (result.status === 401) throw new Error('transient 401')
      return result
    })
    const secondBody = await readJson(second)
    const secondUrl: string = secondBody.data[0].url
    recordAcceptance({ case: 'images_second_source', status: second.status, url: secondUrl })

    const [firstBytes, secondBytes] = await Promise.all(
      [generatedImageUrl, secondUrl].map(async (assetUrl) => new Uint8Array(await (await fetch(assetUrl)).arrayBuffer()))
    )

    const form = new FormData()
    form.set('model', 'agnes-image-2.5-flash')
    form.set('prompt', 'Combine the two shapes into one clean composition, flat design, white background')
    form.set('size', '1024x1024')
    form.append('image', new File([firstBytes], 'input-1.png', { type: 'image/png' }))
    form.append('image', new File([secondBytes], 'input-2.png', { type: 'image/png' }))
    form.set('mask', new File([firstBytes], 'mask.png', { type: 'image/png' }))

    const response = await withTransientRetry(async () => {
      const result = await fetch(url('/v1/images/edits'), { method: 'POST', headers: authHeaders(ctx.apiKey), body: form })
      if (result.status === 401) throw new Error('transient 401')
      return result
    })
    const body = await readJson(response)
    recordAcceptance({ case: 'images_edits', status: response.status, warning: response.headers.get('x-agnes-warning'), body })
    expect(response.status).toBe(200)
    expect(response.headers.get('x-agnes-warning')).toContain('mask')
    expect(body.data[0].url).toMatch(/^https?:\/\//)
    expect(uploadedImageCount(form)).toBe(2)
  }, 300_000)

  it('视频：创建 → 轮询 → 下载（含 Range）', async () => {
    const created = await createVideoWithRetry({
      model: 'agnes-video-2.5-flash',
      prompt: '雨后的未来城市街道，霓虹灯倒映在地面，电影级运镜',
      size: '1280x720',
      seconds: '4'
    })
    const createdBody = created.body
    recordAcceptance({ case: 'videos_create', status: created.status, body: createdBody })
    expect(created.status).toBe(200)
    expect(createdBody.id).toMatch(/^agnes-video-2\.5-flash:[A-Za-z0-9_]+/)

    const deadline = Date.now() + 12 * 60 * 1000
    let payload: any = null
    while (Date.now() < deadline) {
      const poll = await api(`/v1/videos/${encodeURIComponent(createdBody.id)}`)
      payload = await readJson(poll)
      if (payload?.status === 'completed' || payload?.status === 'failed') break
      await new Promise((resolve) => setTimeout(resolve, 3_000))
    }
    recordAcceptance({ case: 'videos_status', status: payload?.status, payload })
    expect(payload?.status).toBe('completed')

    const content = await api(`/v1/videos/${encodeURIComponent(createdBody.id)}/content`)
    let contentStatus = content.status
    let contentType = content.headers.get('content-type')
    let bytes = new Uint8Array(await content.arrayBuffer())
    let redirectFallback = false
    if (content.status === 302) {
      // 边缘运行时无法直连 CDN 时会回退为公开资源重定向
      redirectFallback = true
      const location = content.headers.get('location')!
      const direct = await fetch(location)
      contentStatus = direct.status
      contentType = direct.headers.get('content-type')
      bytes = new Uint8Array(await direct.arrayBuffer())
    }
    recordAcceptance({
      case: 'videos_content',
      status: contentStatus,
      content_type: contentType,
      bytes: bytes.length,
      redirect_fallback: redirectFallback
    })
    expect([200, 206]).toContain(contentStatus)
    expect(bytes.length).toBeGreaterThan(1000)

    const ranged = await api(`/v1/videos/${encodeURIComponent(createdBody.id)}/content`, { headers: { range: 'bytes=0-1023' } })
    recordAcceptance({ case: 'videos_content_range', status: ranged.status, content_range: ranged.headers.get('content-range') })
    expect([200, 206]).toContain(ranged.status)
  }, 900_000)
})

describe.skipIf(!acceptanceContext().enabled)('正式环境安全核查', () => {
  it('错误响应不回显密钥，且不包含上游地址', async () => {
    const response = await api('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'definitely-not-a-real-model', messages: [{ role: 'user', content: 'hi' }], max_tokens: 8 })
    })
    const text = await response.text()
    expect(text).not.toContain(ctx.apiKey)
    expect(text).not.toContain('load.980425.xyz')
    expect(text).not.toContain('apihub.agnes-ai.com')
  }, 60_000)
})
