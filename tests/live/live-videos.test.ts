import { beforeAll, describe, expect, it } from 'vitest'
import { liveContext, readJson, recordResult, type LiveContext } from '../helpers/live.js'
import { withTransientRetry } from '../helpers/env.js'

let live: LiveContext

beforeAll(() => {
  live = liveContext()
})

const POLL_INTERVAL_MS = 3_000
const POLL_TIMEOUT_MS = 12 * 60 * 1000

function post(path: string, body: unknown): Promise<Response> {
  return live.app.request(path, {
    method: 'POST',
    headers: { authorization: `Bearer ${live.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
}

function get(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return live.app.request(path, { headers: { authorization: `Bearer ${live.apiKey}`, ...headers } })
}

async function waitForCompletion(id: string, label: string): Promise<{ status: string; payload: any; elapsedMs: number }> {
  const started = Date.now()
  let last: any = null
  while (Date.now() - started < POLL_TIMEOUT_MS) {
    const response = await get(`/v1/videos/${encodeURIComponent(id)}`)
    last = await readJson(response)
    if (last?.status === 'completed' || last?.status === 'failed') {
      return { status: last.status, payload: last, elapsedMs: Date.now() - started }
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
  recordResult('live-videos.jsonl', { case: `${label}.timeout`, last })
  throw new Error(`video ${id} did not finish within ${POLL_TIMEOUT_MS}ms`)
}


/**
 * Agnes returns 503 `video_queue_full` when the video queue is saturated. The shared test key
 * also occasionally returns a transient 401. Both are retried with backoff.
 */
async function createVideoWithRetry(body: Record<string, unknown>, attempts = 8, delayMs = 25_000): Promise<{ status: number; body: any }> {
  let last: { status: number; body: any } = { status: 0, body: null }
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await post('/v1/videos', body)
    const parsed = await readJson(response)
    last = { status: response.status, body: parsed }
    const retryable =
      response.status === 401 ||
      (response.status === 503 && String(parsed?.error?.code ?? '').includes('queue')) ||
      /queue is full/i.test(String(parsed?.error?.message ?? ''))
    if (!retryable) return last
    recordResult('live-videos.jsonl', { case: 'videos.retry', attempt, status: response.status, body: parsed })
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs))
  }
  return last
}

async function publicImageUrl(prompt: string): Promise<string> {
  return withTransientRetry(async () => {
    const response = await post('/v1/images/generations', { model: 'agnes-image-2.5-flash', prompt, size: '1024x1024' })
    const body = await readJson(response)
    if (response.status === 401) throw new Error('transient 401')
    if (!body?.data?.[0]?.url) throw new Error(`image generation failed: ${JSON.stringify(body).slice(0, 200)}`)
    return body.data[0].url as string
  })
}

describe.skipIf(!liveContext().enabled)('真实上游 · 视频（Flash）', () => {
  it('文生视频：创建 → 查询 → 下载（含 Range）', async () => {
    const created = await createVideoWithRetry({
      model: 'agnes-video-2.5-flash',
      prompt: '雨后的未来城市街道，霓虹灯倒映在地面，一辆银色跑车缓慢驶过，电影级运镜',
      size: '1280x720',
      seconds: '4'
    })
    recordResult('live-videos.jsonl', { case: 'videos.text.create', status: created.status, body: created.body })
    expect(created.status).toBe(200)
    expect(created.body.id).toMatch(/^agnes-video-2\.5-flash:[A-Za-z0-9_]+/)
    expect(created.body.object).toBe('video')
    expect(created.body.size).toBe('1280x720')
    expect(created.body.seconds).toBe('4')
    expect(created.body.error).toBeNull()

    const finished = await waitForCompletion(created.body.id, 'videos.text')
    recordResult('live-videos.jsonl', { case: 'videos.text.completed', elapsed_ms: finished.elapsedMs, status: finished.payload.status })
    expect(finished.status).toBe('completed')
    expect(finished.payload.completed_at).toBeTypeOf('number')

    const content = await get(`/v1/videos/${encodeURIComponent(created.body.id)}/content`)
    const bytes = new Uint8Array(await content.arrayBuffer())
    recordResult('live-videos.jsonl', {
      case: 'videos.text.content',
      status: content.status,
      content_type: content.headers.get('content-type'),
      content_length: content.headers.get('content-length'),
      bytes: bytes.length
    })
    expect(content.status).toBe(200)
    expect(content.headers.get('content-type')).toContain('video/')
    expect(bytes.length).toBeGreaterThan(1000)

    const ranged = await get(`/v1/videos/${encodeURIComponent(created.body.id)}/content`, { range: 'bytes=0-1023' })
    recordResult('live-videos.jsonl', {
      case: 'videos.text.content_range',
      status: ranged.status,
      content_range: ranged.headers.get('content-range')
    })
    expect([200, 206]).toContain(ranged.status)
    if (ranged.status === 206) expect(ranged.headers.get('content-range')).toContain('bytes 0-1023')
  }, 900_000)

  it('首尾帧模式：keyframe 创建并完成', async () => {
    const frame = await publicImageUrl('A calm minimal landscape, soft gradient sky, flat illustration')
    const created = await createVideoWithRetry({
      model: 'agnes-video-2.5-flash',
      prompt: '镜头缓慢向前推进，光线逐渐变暖，保持原始构图',
      seconds: '4',
      first_frame: frame
    })
    recordResult('live-videos.jsonl', { case: 'videos.keyframe.create', status: created.status, body: created.body })
    expect(created.status).toBe(200)

    const finished = await waitForCompletion(created.body.id, 'videos.keyframe')
    recordResult('live-videos.jsonl', { case: 'videos.keyframe.completed', elapsed_ms: finished.elapsedMs, status: finished.payload.status })
    expect(finished.status).toBe('completed')
  }, 900_000)

  it('参考图模式：reference 创建并完成', async () => {
    const reference = await publicImageUrl('A friendly cartoon robot mascot, flat vector style, white background')
    const created = await createVideoWithRetry({
      model: 'agnes-video-2.5-flash',
      prompt: '以 <Picture 1> 中的角色为参考，角色在花田中自然奔跑，保持外观一致',
      seconds: '4',
      size: '720x1280',
      images: [reference]
    })
    recordResult('live-videos.jsonl', { case: 'videos.reference.create', status: created.status, body: created.body })
    expect(created.status).toBe(200)
    expect(created.body.size).toBe('720x1280')

    const finished = await waitForCompletion(created.body.id, 'videos.reference')
    recordResult('live-videos.jsonl', { case: 'videos.reference.completed', elapsed_ms: finished.elapsedMs, status: finished.payload.status })
    expect(finished.status).toBe('completed')

    const content = await get(`/v1/videos/${encodeURIComponent(created.body.id)}/content`)
    const bytes = new Uint8Array(await content.arrayBuffer())
    recordResult('live-videos.jsonl', {
      case: 'videos.reference.content',
      status: content.status,
      content_type: content.headers.get('content-type'),
      bytes: bytes.length
    })
    expect(content.status).toBe(200)
    expect(bytes.length).toBeGreaterThan(1000)
  }, 900_000)

  it('查询不存在的视频返回 404 video_not_found', async () => {
    const response = await get('/v1/videos/agnes-video-2.5-flash:video_does_not_exist_123')
    const body = await readJson(response)
    recordResult('live-videos.jsonl', { case: 'videos.not_found', status: response.status, body })
    expect(response.status).toBe(404)
    expect(body.error.code).toBe('video_not_found')
  }, 120_000)

  it('Flash 限制在网关侧拦截（不产生上游任务）', async () => {
    const tooManyImages = await post('/v1/videos', {
      model: 'agnes-video-2.5-flash',
      prompt: 'x',
      images: Array.from({ length: 6 }, (_, index) => `https://example.com/${index}.png`)
    })
    expect(tooManyImages.status).toBe(400)
    expect((await readJson(tooManyImages)).error.message).toBe('images length must not exceed 5')

    const withVideoReference = await post('/v1/videos', {
      model: 'agnes-video-2.5-flash',
      prompt: 'x',
      videos: [{ url: 'https://example.com/a.mp4' }]
    })
    expect(withVideoReference.status).toBe(400)
    expect((await readJson(withVideoReference)).error.message).toBe('videos is not supported')
  })

  it('未适配视频模型透传', async () => {
    const response = await withTransientRetry(async () => {
      const result = await post('/v1/videos', {
        model: 'agnes-video-2.5',
        prompt: '一只猫在弹钢琴',
        mode: 'text',
        seconds: '4',
        size: '720P',
        aspect_ratio: '16:9'
      })
      if (result.status === 401) throw new Error('transient 401')
      return result
    })
    const body = await readJson(response)
    recordResult('live-videos.jsonl', { case: 'videos.passthrough', status: response.status, body })
    // 联调用的共享测试 key 对 agnes-video-2.5 没有额度，上游会返回 403 配额错误；
    // 网关必须做到「原样透传 body + 错误归一化」，因此 200 或归一化 4xx 都算通过。
    expect([200, 403]).toContain(response.status)
    if (response.status === 200) {
      expect(body.video_id ?? body.id).toBeTruthy()
    } else {
      expect(body.error.type).toBe('authentication_error')
      expect(String(body.error.message)).toContain('quota')
    }
  }, 180_000)
})
