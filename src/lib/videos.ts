import { invalidRequest } from './errors.js'
import { ADAPTED_MODELS, ADAPTED_VIDEO_MODEL } from './config.js'

export const VIDEO_MODES = ['text', 'keyframe', 'reference'] as const
export type VideoMode = (typeof VIDEO_MODES)[number]

export const VIDEO_ASPECT_RATIOS = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'] as const
export type VideoAspectRatio = (typeof VIDEO_ASPECT_RATIOS)[number]

/** Agnes Video 2.5 Flash only supports the 720P tier. */
export const VIDEO_SIZE_TIER = '720P'

const OPENAI_VIDEO_SIZES: Record<string, VideoAspectRatio> = {
  '1280x720': '16:9',
  '720x1280': '9:16',
  '1792x1024': '16:9',
  '1024x1792': '9:16'
}

const PIXELS_BY_RATIO: Record<VideoAspectRatio, string> = {
  '21:9': '1680x720',
  '16:9': '1280x720',
  '4:3': '960x720',
  '1:1': '720x720',
  '3:4': '720x960',
  '9:16': '720x1280'
}

export const DEFAULT_VIDEO_SIZE = '720x1280'
export const DEFAULT_VIDEO_SECONDS = '4'
export const MAX_VIDEO_SECONDS = 12
export const MIN_VIDEO_SECONDS = 4
export const MAX_REFERENCE_IMAGES = 5
export const MAX_REFERENCE_AUDIOS = 3

function isAspectRatio(value: unknown): value is VideoAspectRatio {
  return typeof value === 'string' && (VIDEO_ASPECT_RATIOS as readonly string[]).includes(value)
}

function ratioValue(ratio: string): number {
  const [width, height] = ratio.split(':').map(Number)
  return width / height
}

function nearestAspectRatio(width: number, height: number): VideoAspectRatio {
  const target = Math.log(width / height)
  let best: VideoAspectRatio = '16:9'
  let bestDistance = Number.POSITIVE_INFINITY
  for (const ratio of VIDEO_ASPECT_RATIOS) {
    const distance = Math.abs(Math.log(ratioValue(ratio)) - target)
    if (distance < bestDistance) {
      bestDistance = distance
      best = ratio
    }
  }
  return best
}

export type ResolvedVideoSize = {
  /** OpenAI style pixel size echoed back to the client. */
  pixels: string
  aspectRatio: VideoAspectRatio
  tier: string
}

/**
 * Maps an OpenAI video `size` onto the fixed 720P Agnes tier plus an aspect ratio.
 * Defaults to `720x1280` following the OpenAI Videos schema.
 */
export function resolveVideoSize(size: unknown, aspectOverride: unknown): ResolvedVideoSize {
  if (aspectOverride !== undefined && aspectOverride !== null && aspectOverride !== '') {
    if (!isAspectRatio(aspectOverride)) {
      if (aspectOverride === 'auto') {
        throw invalidRequest('`aspect_ratio` does not support "auto".', { param: 'aspect_ratio', code: 'invalid_aspect_ratio' })
      }
      throw invalidRequest(`\`aspect_ratio\` must be one of ${VIDEO_ASPECT_RATIOS.join(', ')}.`, {
        param: 'aspect_ratio',
        code: 'invalid_aspect_ratio'
      })
    }
  }
  const override = isAspectRatio(aspectOverride) ? aspectOverride : undefined

  if (size === undefined || size === null || size === '') {
    const aspectRatio = override ?? OPENAI_VIDEO_SIZES[DEFAULT_VIDEO_SIZE]!
    return { pixels: PIXELS_BY_RATIO[aspectRatio], aspectRatio, tier: VIDEO_SIZE_TIER }
  }
  if (typeof size !== 'string') {
    throw invalidRequest('`size` must be a string such as "1280x720" or "720P".', { param: 'size', code: 'invalid_size' })
  }
  const trimmed = size.trim()
  if (trimmed === '720P') {
    const aspectRatio = override ?? '16:9'
    return { pixels: PIXELS_BY_RATIO[aspectRatio], aspectRatio, tier: VIDEO_SIZE_TIER }
  }
  const match = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(trimmed)
  if (!match) {
    throw invalidRequest(
      `Unsupported \`size\` value ${JSON.stringify(size)}. Agnes Video 2.5 Flash only supports 720P, so pass "1280x720", "720x1280", or "720P" (optionally with \`aspect_ratio\`).`,
      { param: 'size', code: 'invalid_size' }
    )
  }
  const width = Number(match[1])
  const height = Number(match[2])
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw invalidRequest(`Invalid \`size\` value ${JSON.stringify(size)}.`, { param: 'size', code: 'invalid_size' })
  }
  const exact = OPENAI_VIDEO_SIZES[`${width}x${height}`]
  const aspectRatio = override ?? exact ?? nearestAspectRatio(width, height)
  return { pixels: PIXELS_BY_RATIO[aspectRatio], aspectRatio, tier: VIDEO_SIZE_TIER }
}

export function normalizeSeconds(value: unknown): string {
  if (value === undefined || value === null || value === '') return DEFAULT_VIDEO_SECONDS
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : Number.NaN
  if (!Number.isInteger(parsed) || parsed < MIN_VIDEO_SECONDS || parsed > MAX_VIDEO_SECONDS) {
    throw invalidRequest(`\`seconds\` must be an integer between ${MIN_VIDEO_SECONDS} and ${MAX_VIDEO_SECONDS}.`, {
      param: 'seconds',
      code: 'invalid_seconds'
    })
  }
  return String(parsed)
}

export function encodeVideoId(model: string, videoId: string): string {
  return `${model}:${videoId}`
}

export type DecodedVideoId = {
  model?: string
  videoId: string
  hadPrefix: boolean
}

export function decodeVideoId(rawId: string): DecodedVideoId {
  const separator = rawId.indexOf(':')
  if (separator > 0) {
    const prefix = rawId.slice(0, separator)
    if ((ADAPTED_MODELS as readonly string[]).includes(prefix)) {
      return { model: prefix, videoId: rawId.slice(separator + 1), hadPrefix: true }
    }
  }
  return { videoId: rawId, hadPrefix: false }
}

function asStringArray(value: unknown, param: string): string[] {
  if (value === undefined || value === null) return []
  const list = Array.isArray(value) ? value : [value]
  const result: string[] = []
  for (const item of list) {
    if (typeof item !== 'string' || item.trim().length === 0) {
      throw invalidRequest(`\`${param}\` entries must be public URLs.`, { param, code: 'invalid_reference' })
    }
    result.push(item)
  }
  return result
}

function asMode(value: unknown): VideoMode | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || !(VIDEO_MODES as readonly string[]).includes(value)) {
    throw invalidRequest(`\`mode\` must be one of ${VIDEO_MODES.join(', ')}.`, { param: 'mode', code: 'invalid_mode' })
  }
  return value as VideoMode
}

export type VideoCreatePlan = {
  model: string
  prompt: string
  mode: VideoMode
  seconds: string
  size: ResolvedVideoSize
  upstreamBody: Record<string, unknown>
}

/**
 * Maps an OpenAI style video creation request onto the Agnes Video 2.5 Flash request body,
 * including Flash specific limits (720P only, <=5 images, <=3 audios, no video references).
 */
export function planVideoCreate(body: Record<string, any>): VideoCreatePlan {
  const prompt = body.prompt
  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    throw invalidRequest('`prompt` is required and must be a non-empty string.', { param: 'prompt', code: 'invalid_prompt' })
  }

  // Agnes validates Flash limits in the order: size -> images -> audios -> videos.
  const size = resolveVideoSize(body.size, body.aspect_ratio)
  const seconds = normalizeSeconds(body.seconds)

  const firstFrame = typeof body.first_frame === 'string' && body.first_frame.trim() ? body.first_frame.trim() : undefined
  const lastFrame = typeof body.last_frame === 'string' && body.last_frame.trim() ? body.last_frame.trim() : undefined
  const images = asStringArray(body.images, 'images')
  const audios = asStringArray(body.audios, 'audios')

  if (images.length > MAX_REFERENCE_IMAGES) {
    throw invalidRequest('images length must not exceed 5', { param: 'images', code: 'too_many_images' })
  }
  if (audios.length > MAX_REFERENCE_AUDIOS) {
    throw invalidRequest('audios length must not exceed 3', { param: 'audios', code: 'too_many_audios' })
  }
  const hasVideoReference = Array.isArray(body.videos) ? body.videos.length > 0 : body.videos !== undefined && body.videos !== null
  if (hasVideoReference) {
    throw invalidRequest('videos is not supported', { param: 'videos', code: 'videos_not_supported' })
  }

  let inputReferenceImage: string | undefined
  const inputReference = body.input_reference
  if (inputReference !== undefined && inputReference !== null && inputReference !== '') {
    if (typeof inputReference === 'string') {
      inputReferenceImage = inputReference
    } else if (typeof inputReference === 'object' && !Array.isArray(inputReference)) {
      if (typeof inputReference.image_url === 'string' && inputReference.image_url.trim()) {
        inputReferenceImage = inputReference.image_url
      } else if (typeof inputReference.file_id === 'string') {
        throw invalidRequest(
          'Binary `input_reference.file_id` uploads are not supported by this gateway. 请改用公网可访问的图片 URL：`input_reference: {"image_url": "https://..."}` 或 `images: ["https://..."]`。',
          { param: 'input_reference.file_id', code: 'file_id_not_supported' }
        )
      } else {
        throw invalidRequest('`input_reference` must be an image URL string or {"image_url": "https://..."}.', {
          param: 'input_reference',
          code: 'invalid_input_reference'
        })
      }
    } else {
      throw invalidRequest('`input_reference` must be an image URL string or {"image_url": "https://..."}.', {
        param: 'input_reference',
        code: 'invalid_input_reference'
      })
    }
  }

  const referenceImages = inputReferenceImage ? [...images, inputReferenceImage] : images
  if (referenceImages.length > MAX_REFERENCE_IMAGES) {
    throw invalidRequest('images length must not exceed 5', { param: 'images', code: 'too_many_images' })
  }

  const explicitMode = asMode(body.mode)
  const hasFrames = Boolean(firstFrame || lastFrame)
  const hasReferenceMedia = referenceImages.length > 0 || audios.length > 0

  let mode: VideoMode
  if (explicitMode) {
    mode = explicitMode
    if (mode === 'text' && (hasFrames || hasReferenceMedia)) {
      throw invalidRequest('`mode: "text"` does not accept reference media (first_frame/last_frame/images/audios).', {
        param: 'mode',
        code: 'mode_media_mismatch'
      })
    }
    if (mode === 'keyframe' && hasReferenceMedia) {
      throw invalidRequest('`mode: "keyframe"` only accepts first_frame/last_frame; use `mode: "reference"` for images/audios.', {
        param: 'mode',
        code: 'mode_media_mismatch'
      })
    }
    if (mode === 'keyframe' && !hasFrames) {
      throw invalidRequest('`mode: "keyframe"` requires first_frame and/or last_frame.', { param: 'mode', code: 'missing_media' })
    }
    if (mode === 'reference' && hasFrames) {
      throw invalidRequest('`mode: "reference"` does not accept first_frame/last_frame.', { param: 'mode', code: 'mode_media_mismatch' })
    }
    if (mode === 'reference' && !hasReferenceMedia) {
      throw invalidRequest('`mode: "reference"` requires at least one image or audio reference.', { param: 'mode', code: 'missing_media' })
    }
  } else if (hasFrames) {
    mode = 'keyframe'
  } else if (hasReferenceMedia) {
    mode = 'reference'
  } else {
    mode = 'text'
  }

  const upstreamBody: Record<string, unknown> = {
    model: ADAPTED_VIDEO_MODEL,
    prompt,
    mode,
    seconds,
    size: VIDEO_SIZE_TIER,
    aspect_ratio: size.aspectRatio
  }
  if (typeof body.seed === 'number' && Number.isFinite(body.seed)) upstreamBody.seed = body.seed
  if (firstFrame) upstreamBody.first_frame = firstFrame
  if (lastFrame) upstreamBody.last_frame = lastFrame
  if (referenceImages.length > 0) upstreamBody.images = referenceImages
  if (audios.length > 0) upstreamBody.audios = audios

  return { model: ADAPTED_VIDEO_MODEL, prompt, mode, seconds, size, upstreamBody }
}

export function normalizeVideoPayload(
  payload: Record<string, any>,
  options: { id: string; model: string; prompt: string | null; size: string; seconds: string }
): Record<string, unknown> {
  const error = payload?.error
  const normalized: Record<string, unknown> = {
    id: options.id,
    object: 'video',
    model: options.model,
    status: typeof payload?.status === 'string' ? payload.status : 'queued',
    progress: typeof payload?.progress === 'number' ? payload.progress : 0,
    created_at: typeof payload?.created_at === 'number' ? payload.created_at : Math.floor(Date.now() / 1000),
    completed_at: typeof payload?.completed_at === 'number' ? payload.completed_at : null,
    expires_at: typeof payload?.expires_at === 'number' ? payload.expires_at : null,
    prompt: typeof payload?.prompt === 'string' ? payload.prompt : options.prompt,
    size: options.size,
    seconds: typeof payload?.seconds === 'string' && payload.seconds ? payload.seconds : options.seconds,
    remixed_from_video_id: typeof payload?.remixed_from_video_id === 'string' ? payload.remixed_from_video_id : null,
    error:
      error && typeof error === 'object'
        ? {
            code: typeof error.code === 'string' ? error.code : 'video_generation_failed',
            message: typeof error.message === 'string' ? error.message : 'Video generation failed.'
          }
        : null
  }
  return normalized
}

/** Best-effort pixel size for status responses, where the original aspect ratio is not known. */
export function videoPixelsFromUpstreamSize(size: unknown): string {
  if (typeof size === 'string' && /^\d+\s*[x×]\s*\d+$/i.test(size.trim())) return size.trim().replace(/\s*[×x]\s*/i, 'x')
  if (size === '720P' || size === '1080P' || size === '1K' || size === '2K') {
    return {
      '720P': '1280x720',
      '1080P': '1920x1080',
      '1K': '1024x1024',
      '2K': '2560x1440'
    }[size]
  }
  return PIXELS_BY_RATIO['16:9']
}
