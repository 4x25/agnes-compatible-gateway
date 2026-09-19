import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/app.js'
import { decodeVideoId, encodeVideoId, normalizeSeconds, resolveVideoSize } from '../../src/lib/videos.js'
import { installFetchMock, jsonResponse, proxyBaseUrl } from '../helpers/mock.js'

const app = createApp()

afterEach(() => {
  vi.unstubAllGlobals()
})

function createVideo(body: Record<string, unknown>) {
  return app.request('/v1/videos', {
    method: 'POST',
    headers: { authorization: 'Bearer sk-test', 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
}

function getVideo(id: string) {
  return app.request(`/v1/videos/${encodeURIComponent(id)}`, { headers: { authorization: 'Bearer sk-test' } })
}

const createdPayload = {
  id: 'task_1',
  task_id: 'task_1',
  video_id: 'video_1',
  object: 'video',
  model: 'agnes-video-2.5-flash',
  status: 'queued',
  progress: 0,
  created_at: 1786900000,
  seconds: '5',
  size: '720P'
}

describe('视频尺寸与时长映射', () => {
  it('默认 720x1280（9:16）', () => {
    expect(resolveVideoSize(undefined, undefined)).toEqual({ pixels: '720x1280', aspectRatio: '9:16', tier: '720P' })
  })

  it('OpenAI 尺寸映射到固定 720P 档位', () => {
    expect(resolveVideoSize('1280x720', undefined)).toMatchObject({ pixels: '1280x720', aspectRatio: '16:9', tier: '720P' })
    expect(resolveVideoSize('1792x1024', undefined)).toMatchObject({ aspectRatio: '16:9' })
    expect(resolveVideoSize('1024x1792', undefined)).toMatchObject({ aspectRatio: '9:16' })
  })

  it('支持 720P 与最近画幅推导', () => {
    expect(resolveVideoSize('720P', '4:3')).toMatchObject({ aspectRatio: '4:3', tier: '720P' })
    expect(resolveVideoSize('1000x1000', undefined)).toMatchObject({ aspectRatio: '1:1' })
  })

  it('aspect_ratio 覆盖与非法值', () => {
    expect(resolveVideoSize('1280x720', '21:9')).toMatchObject({ aspectRatio: '21:9', pixels: '1680x720' })
    expect(() => resolveVideoSize('1280x720', 'auto')).toThrowError(/auto/)
    expect(() => resolveVideoSize('1280x720', '5:4')).toThrowError(/aspect_ratio/)
  })

  it('seconds 归一化为 4-12 的字符串', () => {
    expect(normalizeSeconds(undefined)).toBe('4')
    expect(normalizeSeconds('8')).toBe('8')
    expect(normalizeSeconds(12)).toBe('12')
    expect(() => normalizeSeconds(3)).toThrowError(/between 4 and 12/)
    expect(() => normalizeSeconds('5.5')).toThrowError(/between 4 and 12/)
    expect(() => normalizeSeconds('abc')).toThrowError(/between 4 and 12/)
  })

  it('视频 ID 编解码', () => {
    expect(encodeVideoId('agnes-video-2.5-flash', 'video_1')).toBe('agnes-video-2.5-flash:video_1')
    expect(decodeVideoId('agnes-video-2.5-flash:video_1')).toEqual({ model: 'agnes-video-2.5-flash', videoId: 'video_1', hadPrefix: true })
    expect(decodeVideoId('video_1')).toEqual({ videoId: 'video_1', hadPrefix: false })
    expect(decodeVideoId('other:video_1')).toEqual({ videoId: 'other:video_1', hadPrefix: false })
  })
})

describe('创建视频任务', () => {
  it('文生视频请求体符合上游白名单', async () => {
    const mock = installFetchMock(() => jsonResponse(createdPayload))
    const response = await createVideo({
      model: 'agnes-video-2.5-flash',
      prompt: '一只猫在弹钢琴',
      seconds: '5',
      size: '1280x720',
      n: 1
    })
    expect(response.status).toBe(200)
    const sent = mock.calls[0]!.body
    expect(Object.keys(sent).sort()).toEqual(['aspect_ratio', 'mode', 'model', 'prompt', 'seconds', 'size'])
    expect(sent).toMatchObject({
      model: 'agnes-video-2.5-flash',
      mode: 'text',
      seconds: '5',
      size: '720P',
      aspect_ratio: '16:9'
    })
    expect(mock.calls[0]!.url).toBe(`${proxyBaseUrl()}/videos`)
  })

  it('响应使用 <model>:<video_id> 并补齐 OpenAI 视频字段', async () => {
    installFetchMock(() => jsonResponse(createdPayload))
    const body = await (await createVideo({ model: 'agnes-video-2.5-flash', prompt: 'x' })).json()
    expect(body.id).toBe('agnes-video-2.5-flash:video_1')
    expect(body.object).toBe('video')
    expect(body.status).toBe('queued')
    expect(body.size).toBe('720x1280')
    // 请求未指定 seconds 时默认 "4"，响应回显上游上报的时长
    expect(body.seconds).toBe('5')
    expect(body).toMatchObject({ completed_at: null, expires_at: null, remixed_from_video_id: null, error: null })
    expect(body.prompt).toBe('x')
  })

  it('input_reference 图片 URL 走 reference 模式', async () => {
    const mock = installFetchMock(() => jsonResponse(createdPayload))
    await createVideo({
      model: 'agnes-video-2.5-flash',
      prompt: 'keep the style',
      input_reference: { image_url: 'https://example.com/a.png' }
    })
    expect(mock.calls[0]!.body.mode).toBe('reference')
    expect(mock.calls[0]!.body.images).toEqual(['https://example.com/a.png'])
  })

  it('file_id 上传返回清晰 400', async () => {
    const mock = installFetchMock(() => jsonResponse({}))
    const response = await createVideo({ model: 'agnes-video-2.5-flash', prompt: 'x', input_reference: { file_id: 'file-1' } })
    expect(response.status).toBe(400)
    expect((await response.json()).error.code).toBe('file_id_not_supported')
    expect(mock.calls).toHaveLength(0)
  })

  it('multipart 二进制上传返回清晰 400', async () => {
    const mock = installFetchMock(() => jsonResponse({}))
    const form = new FormData()
    form.set('model', 'agnes-video-2.5-flash')
    form.set('prompt', 'x')
    form.append('input_reference', new File([new Uint8Array([1])], 'a.png', { type: 'image/png' }))
    const response = await app.request('/v1/videos', { method: 'POST', headers: { authorization: 'Bearer sk-test' }, body: form })
    expect(response.status).toBe(400)
    expect((await response.json()).error.code).toBe('binary_upload_not_supported')
    expect(mock.calls).toHaveLength(0)
  })

  it('首尾帧推断为 keyframe 模式', async () => {
    const mock = installFetchMock(() => jsonResponse(createdPayload))
    await createVideo({ model: 'agnes-video-2.5-flash', prompt: 'x', first_frame: 'https://example.com/f.png', last_frame: 'https://example.com/l.png' })
    expect(mock.calls[0]!.body.mode).toBe('keyframe')
    expect(mock.calls[0]!.body.first_frame).toBe('https://example.com/f.png')
    expect(mock.calls[0]!.body.last_frame).toBe('https://example.com/l.png')
  })

  it('显式 mode 与素材冲突时报错', async () => {
    installFetchMock(() => jsonResponse(createdPayload))
    const response = await createVideo({ model: 'agnes-video-2.5-flash', prompt: 'x', mode: 'text', first_frame: 'https://example.com/f.png' })
    expect(response.status).toBe(400)
    expect((await response.json()).error.code).toBe('mode_media_mismatch')
  })

  it('keyframe 缺少帧时报错', async () => {
    installFetchMock(() => jsonResponse(createdPayload))
    const response = await createVideo({ model: 'agnes-video-2.5-flash', prompt: 'x', mode: 'keyframe' })
    expect(response.status).toBe(400)
    expect((await response.json()).error.code).toBe('missing_media')
  })

  it('reference 模式没有素材时报错', async () => {
    installFetchMock(() => jsonResponse(createdPayload))
    const response = await createVideo({ model: 'agnes-video-2.5-flash', prompt: 'x', mode: 'reference' })
    expect(response.status).toBe(400)
    expect((await response.json()).error.code).toBe('missing_media')
  })

  it('未适配模型原样透传', async () => {
    const mock = installFetchMock(() => jsonResponse({ id: 'task_9', video_id: 'video_9', status: 'queued' }))
    const payload = { model: 'agnes-video-2.5', prompt: 'x', mode: 'text', size: '1080P', aspect_ratio: '16:9' }
    const response = await createVideo(payload)
    expect(mock.calls[0]!.body).toEqual(payload)
    expect((await response.json()).id).toBe('task_9')
  })
})

describe('Flash 专属限制', () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['图片超过 5 张', { mode: 'reference', images: Array.from({ length: 6 }, (_, i) => `https://example.com/${i}.png`) }, 'images length must not exceed 5'],
    ['音频超过 3 段', { mode: 'reference', audios: Array.from({ length: 4 }, (_, i) => `https://example.com/${i}.mp3`) }, 'audios length must not exceed 3'],
    ['参考视频不支持', { mode: 'reference', videos: [{ url: 'https://example.com/v.mp4' }] }, 'videos is not supported']
  ]

  for (const [name, extra, message] of cases) {
    it(`${name} 返回 400`, async () => {
      const mock = installFetchMock(() => jsonResponse(createdPayload))
      const response = await createVideo({ model: 'agnes-video-2.5-flash', prompt: 'x', ...extra })
      expect(response.status).toBe(400)
      expect((await response.json()).error.message).toBe(message)
      expect(mock.calls).toHaveLength(0)
    })
  }

  it('size 校验先于素材校验（与上游一致）', async () => {
    installFetchMock(() => jsonResponse(createdPayload))
    const response = await createVideo({
      model: 'agnes-video-2.5-flash',
      prompt: 'x',
      size: '1920x1080s',
      images: Array.from({ length: 6 }, (_, i) => `https://example.com/${i}.png`)
    })
    expect(response.status).toBe(400)
    expect((await response.json()).error.param).toBe('size')
  })

  it('5 张图与 3 段音频可以通过', async () => {
    const mock = installFetchMock(() => jsonResponse(createdPayload))
    const response = await createVideo({
      model: 'agnes-video-2.5-flash',
      prompt: 'x',
      mode: 'reference',
      images: Array.from({ length: 5 }, (_, i) => `https://example.com/${i}.png`),
      audios: Array.from({ length: 3 }, (_, i) => `https://example.com/${i}.mp3`)
    })
    expect(response.status).toBe(200)
    expect(mock.calls[0]!.body.images).toHaveLength(5)
    expect(mock.calls[0]!.body.audios).toHaveLength(3)
  })
})

describe('查询视频任务', () => {
  it('带前缀的 ID 会传 model_name', async () => {
    const mock = installFetchMock(() => jsonResponse({ ...createdPayload, status: 'in_progress', progress: 40 }))
    const response = await getVideo('agnes-video-2.5-flash:video_1')
    expect(mock.calls[0]!.url).toBe(`${proxyBaseUrl().replace(/\/v1$/, '')}/agnesapi?video_id=video_1&model_name=agnes-video-2.5-flash`)
    const body = await response.json()
    expect(body.id).toBe('agnes-video-2.5-flash:video_1')
    expect(body.status).toBe('in_progress')
    expect(body.progress).toBe(40)
  })

  it('裸 ID 不带 model_name', async () => {
    const mock = installFetchMock(() => jsonResponse(createdPayload))
    await getVideo('video_1')
    expect(mock.calls[0]!.url).toBe(`${proxyBaseUrl().replace(/\/v1$/, '')}/agnesapi?video_id=video_1`)
    expect(mock.calls[0]!.url).not.toContain('model_name')
  })

  it('上游 404 归一化为 video_not_found', async () => {
    installFetchMock(() => jsonResponse({ error: { code: 404, message: 'task not found (request id: abc)' } }, 404))
    const response = await getVideo('agnes-video-2.5-flash:video_missing')
    expect(response.status).toBe(404)
    const body = await response.json()
    expect(body.error.code).toBe('video_not_found')
    expect(body.error.message).toContain('task not found')
  })

  it('失败任务保留错误信息', async () => {
    installFetchMock(() =>
      jsonResponse({ ...createdPayload, status: 'failed', progress: 100, metadata: null, error: { message: 'Invalid reference media' } })
    )
    const body = await (await getVideo('agnes-video-2.5-flash:video_1')).json()
    expect(body.status).toBe('failed')
    expect(body.error).toEqual({ code: 'video_generation_failed', message: 'Invalid reference media' })
  })
})

describe('下载视频内容', () => {
  const completed = {
    ...createdPayload,
    status: 'completed',
    progress: 100,
    completed_at: 1786900120,
    metadata: { url: 'https://cdn.test/video.mp4' }
  }

  it('未完成返回 409 video_not_ready', async () => {
    installFetchMock(() => jsonResponse({ ...createdPayload, status: 'in_progress' }))
    const response = await app.request('/v1/videos/agnes-video-2.5-flash:video_1/content', { headers: { authorization: 'Bearer sk-test' } })
    expect(response.status).toBe(409)
    expect((await response.json()).error.code).toBe('video_not_ready')
  })

  it('失败任务返回 409 并带上游错误', async () => {
    installFetchMock(() => jsonResponse({ ...createdPayload, status: 'failed', error: { message: 'boom' } }))
    const response = await app.request('/v1/videos/video_1/content', { headers: { authorization: 'Bearer sk-test' } })
    expect(response.status).toBe(409)
    expect((await response.json()).error.message).toContain('boom')
  })

  it('完成的视频流式返回 mp4，且不向上游 CDN 发送密钥', async () => {
    const bytes = new Uint8Array([0, 0, 0, 24])
    const mock = installFetchMock((call) => {
      if (call.url.startsWith('https://cdn.test/')) {
        return new Response(bytes, { status: 200, headers: { 'content-type': 'video/mp4', 'content-length': '4' } })
      }
      return jsonResponse(completed)
    })
    const response = await app.request('/v1/videos/agnes-video-2.5-flash:video_1/content', { headers: { authorization: 'Bearer sk-test' } })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('video/mp4')
    expect(response.headers.get('content-length')).toBe('4')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes)

    const cdnCall = mock.calls.find((call) => call.url.startsWith('https://cdn.test/'))!
    expect(cdnCall.headers.authorization).toBeUndefined()
  })

  it('兼容上游实际返回的顶层 url 字段（无 metadata）', async () => {
    const mock = installFetchMock((call) => {
      if (call.url.startsWith('https://cdn.test/')) return new Response(new Uint8Array([9, 9, 9]), { status: 200 })
      return jsonResponse({
        id: 'task_1',
        video_id: 'video_1',
        object: 'video',
        status: 'completed',
        progress: 100,
        seconds: '4',
        size: '720P',
        url: 'https://cdn.test/top-level.mp4'
      })
    })
    const response = await app.request('/v1/videos/video_1/content', { headers: { authorization: 'Bearer sk-test' } })
    expect(mock.calls.some((call) => call.url === 'https://cdn.test/top-level.mp4')).toBe(true)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('video/mp4')
  })

  it('Range 请求透传并获得 206', async () => {
    const mock = installFetchMock((call) => {
      if (call.url.startsWith('https://cdn.test/')) {
        return new Response(new Uint8Array([1, 2]), {
          status: 206,
          headers: { 'content-type': 'video/mp4', 'content-range': 'bytes 0-1/4', 'content-length': '2' }
        })
      }
      return jsonResponse(completed)
    })
    const response = await app.request('/v1/videos/video_1/content', {
      headers: { authorization: 'Bearer sk-test', range: 'bytes=0-1' }
    })
    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe('bytes 0-1/4')
    const cdnCall = mock.calls.find((call) => call.url.startsWith('https://cdn.test/'))!
    expect(cdnCall.headers.range).toBe('bytes=0-1')
  })

  it('无法直连资源主机时回退为 302 重定向到公开资源地址', async () => {
    installFetchMock((call) => {
      if (call.url.startsWith('https://cdn.test/')) throw new TypeError('fetch failed')
      return jsonResponse(completed)
    })
    const response = await app.request('/v1/videos/agnes-video-2.5-flash:video_1/content', { headers: { authorization: 'Bearer sk-test' } })
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('https://cdn.test/video.mp4')
    expect(response.headers.get('x-agnes-warning')).toContain('redirect')
  })

  it('variant=thumbnail 返回 400', async () => {
    const mock = installFetchMock(() => jsonResponse(completed))
    const response = await app.request('/v1/videos/video_1/content?variant=thumbnail', { headers: { authorization: 'Bearer sk-test' } })
    expect(response.status).toBe(400)
    expect((await response.json()).error.code).toBe('variant_not_supported')
    expect(mock.calls).toHaveLength(0)
  })

  it('variant=video 可用', async () => {
    installFetchMock((call) => {
      if (call.url.startsWith('https://cdn.test/')) return new Response(new Uint8Array([1]), { status: 200 })
      return jsonResponse(completed)
    })
    const response = await app.request('/v1/videos/video_1/content?variant=video', { headers: { authorization: 'Bearer sk-test' } })
    expect(response.status).toBe(200)
  })
})
