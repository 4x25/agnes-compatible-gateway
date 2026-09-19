import type { Context } from 'hono'
import { ADAPTED_VIDEO_MODEL, resolveUpstreamConfig } from '../lib/config.js'
import { readJsonBody } from '../lib/body.js'
import { ApiError, invalidRequest } from '../lib/errors.js'
import { callUpstream, passthroughResponse, readUpstreamJson, TIMEOUT, upstreamErrorFrom } from '../lib/upstream.js'
import { decodeVideoId, encodeVideoId, normalizeVideoPayload, planVideoCreate, videoPixelsFromUpstreamSize } from '../lib/videos.js'
import type { AppEnv, JsonObject } from '../types.js'

async function fetchVideoStatus(
  c: Context<AppEnv>,
  rawId: string
): Promise<{ payload: JsonObject; decoded: ReturnType<typeof decodeVideoId> }> {
  const { queryUrl } = resolveUpstreamConfig(c.env)
  const decoded = decodeVideoId(rawId)
  const search = new URLSearchParams({ video_id: decoded.videoId })
  if (decoded.model) search.set('model_name', decoded.model)

  const upstream = await callUpstream({
    url: `${queryUrl}?${search.toString()}`,
    method: 'GET',
    apiKey: c.get('agnesKey'),
    timeoutMs: TIMEOUT.video,
    signal: c.req.raw.signal
  })
  if (!upstream.ok) {
    const error = await upstreamErrorFrom(upstream)
    if (error.status === 404) {
      throw new ApiError(404, 'invalid_request_error', `Video ${JSON.stringify(rawId)} was not found. ${error.message}`, {
        code: 'video_not_found'
      })
    }
    throw error
  }
  return { payload: await readUpstreamJson(upstream), decoded }
}

export async function createVideo(c: Context<AppEnv>): Promise<Response> {
  const { baseUrl } = resolveUpstreamConfig(c.env)
  const apiKey = c.get('agnesKey')
  const contentType = c.req.header('content-type') ?? ''
  if (/multipart\/form-data/i.test(contentType)) {
    throw invalidRequest(
      'Binary video reference uploads are not supported: Agnes accepts public URLs only. 请改用 `input_reference: {"image_url": "https://..."}` 或 `images: ["https://..."]`。',
      { param: 'input_reference', code: 'binary_upload_not_supported' }
    )
  }

  const body = await readJsonBody(c.req.raw)
  const model = typeof body.model === 'string' ? body.model : ''

  if (model !== ADAPTED_VIDEO_MODEL) {
    const upstream = await callUpstream({
      url: `${baseUrl}/videos`,
      apiKey,
      body: JSON.stringify(body),
      timeoutMs: TIMEOUT.video,
      signal: c.req.raw.signal
    })
    if (!upstream.ok) throw await upstreamErrorFrom(upstream)
    return passthroughResponse(upstream)
  }

  const plan = planVideoCreate(body)
  const upstream = await callUpstream({
    url: `${baseUrl}/videos`,
    apiKey,
    body: JSON.stringify(plan.upstreamBody),
    timeoutMs: TIMEOUT.video,
    signal: c.req.raw.signal
  })
  if (!upstream.ok) throw await upstreamErrorFrom(upstream)
  const payload = await readUpstreamJson(upstream)

  const videoId =
    typeof payload?.video_id === 'string' && payload.video_id ? payload.video_id : typeof payload?.id === 'string' ? payload.id : ''
  if (!videoId) throw new ApiError(502, 'upstream_error', 'Upstream service did not return a video id.')

  return c.json(
    normalizeVideoPayload(payload, {
      id: encodeVideoId(plan.model, videoId),
      model: plan.model,
      prompt: plan.prompt,
      size: plan.size.pixels,
      seconds: plan.seconds
    })
  )
}

export async function getVideo(c: Context<AppEnv>): Promise<Response> {
  const rawId = decodeURIComponent(c.req.param('video_id') ?? '')
  if (!rawId) throw invalidRequest('`video_id` is required.', { param: 'video_id', code: 'invalid_video_id' })

  const { payload, decoded } = await fetchVideoStatus(c, rawId)
  const upstreamVideoId = typeof payload?.video_id === 'string' && payload.video_id ? payload.video_id : decoded.videoId
  const model = decoded.model ?? (typeof payload?.model === 'string' ? payload.model : '')
  const id = decoded.hadPrefix && decoded.model ? encodeVideoId(decoded.model, upstreamVideoId) : typeof payload?.id === 'string' ? payload.id : upstreamVideoId

  return c.json(
    normalizeVideoPayload(payload, {
      id,
      model,
      prompt: null,
      size: videoPixelsFromUpstreamSize(payload?.size),
      seconds: typeof payload?.seconds === 'string' && payload.seconds ? payload.seconds : '5'
    })
  )
}

export async function getVideoContent(c: Context<AppEnv>): Promise<Response> {
  const variant = c.req.query('variant')
  if (variant !== undefined && variant !== '' && variant !== 'video') {
    throw invalidRequest(`\`variant\` ${JSON.stringify(variant)} is not supported. Agnes only exposes the generated video file.`, {
      param: 'variant',
      code: 'variant_not_supported'
    })
  }

  const rawId = decodeURIComponent(c.req.param('video_id') ?? '')
  if (!rawId) throw invalidRequest('`video_id` is required.', { param: 'video_id', code: 'invalid_video_id' })

  const { payload } = await fetchVideoStatus(c, rawId)
  const status = typeof payload?.status === 'string' ? payload.status : ''
  // Agnes 文档描述为 metadata.url，线上实际返回顶层 url，两种形态都要兼容。
  const assetUrl = payload?.metadata?.url ?? payload?.url

  if (status === 'failed') {
    const detail = typeof payload?.error?.message === 'string' ? ` ${payload.error.message}` : ''
    throw new ApiError(409, 'invalid_request_error', `Video generation failed.${detail}`, { code: 'video_not_ready' })
  }
  if (status !== 'completed' || typeof assetUrl !== 'string' || assetUrl.length === 0) {
    throw new ApiError(409, 'invalid_request_error', `Video ${JSON.stringify(rawId)} is not ready yet (status: ${status || 'unknown'}). 请稍后重试。`, {
      code: 'video_not_ready'
    })
  }

  const headers: Record<string, string> = {}
  const range = c.req.header('range')
  if (range) headers.Range = range

  try {
    const upstream = await callUpstream({
      url: assetUrl,
      method: 'GET',
      auth: false,
      headers,
      timeoutMs: TIMEOUT.content,
      signal: c.req.raw.signal
    })
    if (!upstream.ok && upstream.status !== 206) throw await upstreamErrorFrom(upstream)

    const responseHeaders: Record<string, string> = {
      'Content-Type': upstream.headers.get('content-type') ?? 'video/mp4'
    }
    for (const header of ['content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
      const value = upstream.headers.get(header)
      if (value) responseHeaders[header] = value
    }

    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders })
  } catch (error) {
    // Some edge runtimes cannot open an outbound connection to the asset CDN (Wasmer Edge
    // currently fails with ENOSYS). The asset URL is public, so fall back to a redirect.
    if (!(error instanceof ApiError) || error.type !== 'upstream_error') throw error
    console.warn(
      JSON.stringify({
        level: 'warn',
        msg: 'video_content_redirect_fallback',
        reason: error.message.slice(0, 240)
      })
    )
    return new Response(null, {
      status: 302,
      headers: {
        Location: assetUrl,
        'x-agnes-warning': 'Gateway could not stream the asset directly; redirecting to the public asset URL.'
      }
    })
  }
}
