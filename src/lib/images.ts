import { invalidRequest } from './errors.js'

export const IMAGE_TIERS = ['1K', '2K', '3K', '4K'] as const
export type ImageTier = (typeof IMAGE_TIERS)[number]

export const IMAGE_RATIOS = ['1:1', '3:4', '4:3', '16:9', '9:16', '2:3', '3:2', '21:9'] as const
export type ImageRatio = (typeof IMAGE_RATIOS)[number]

/** Native output sizes documented by Agnes Image 2.5 Flash (ratio -> 1K/2K/3K/4K). */
const NATIVE_SIZES: Record<ImageRatio, [string, string, string, string]> = {
  '1:1': ['1024x1024', '2048x2048', '3072x3072', '4096x4096'],
  '3:4': ['864x1152', '1728x2304', '2592x3456', '3456x4608'],
  '4:3': ['1152x864', '2304x1728', '3456x2592', '4608x3456'],
  '16:9': ['1312x736', '2624x1472', '3936x2208', '5248x2944'],
  '9:16': ['736x1312', '1472x2624', '2208x3936', '2944x5248'],
  '2:3': ['832x1248', '1664x2496', '2496x3744', '3328x4992'],
  '3:2': ['1248x832', '2496x1664', '3744x2496', '4992x3328'],
  '21:9': ['1568x672', '3136x1344', '4704x2016', '6272x2688']
}

const EXACT_SIZE_LOOKUP: Map<string, { tier: ImageTier; ratio: ImageRatio }> = (() => {
  const lookup = new Map<string, { tier: ImageTier; ratio: ImageRatio }>()
  for (const [ratio, sizes] of Object.entries(NATIVE_SIZES) as Array<[ImageRatio, [string, string, string, string]]>) {
    sizes.forEach((size, index) => lookup.set(size, { tier: IMAGE_TIERS[index] as ImageTier, ratio }))
  }
  return lookup
})()

export type ResolvedImageSize = {
  tier: ImageTier
  ratio: ImageRatio
}

export function isImageRatio(value: unknown): value is ImageRatio {
  return typeof value === 'string' && (IMAGE_RATIOS as readonly string[]).includes(value)
}

function isImageTier(value: unknown): value is ImageTier {
  return typeof value === 'string' && (IMAGE_TIERS as readonly string[]).includes(value)
}

function ratioValue(ratio: string): number {
  const [width, height] = ratio.split(':').map(Number)
  return width / height
}

function nearestRatio(width: number, height: number): ImageRatio {
  const target = Math.log(width / height)
  let best: ImageRatio = '1:1'
  let bestDistance = Number.POSITIVE_INFINITY
  for (const ratio of IMAGE_RATIOS) {
    const distance = Math.abs(Math.log(ratioValue(ratio)) - target)
    if (distance < bestDistance) {
      bestDistance = distance
      best = ratio
    }
  }
  return best
}

function tierForLongestEdge(longestEdge: number): ImageTier {
  if (longestEdge <= 1024) return '1K'
  if (longestEdge <= 2048) return '2K'
  if (longestEdge <= 3072) return '3K'
  return '4K'
}

/**
 * Maps an OpenAI `size` (tier name or `WIDTHxHEIGHT`) onto the Agnes tier + aspect ratio pair.
 * Defaults to `1024x1024` when no size is provided.
 */
export function resolveImageSize(size: unknown, ratioOverride: unknown): ResolvedImageSize {
  if (ratioOverride !== undefined && ratioOverride !== null && ratioOverride !== '') {
    if (!isImageRatio(ratioOverride)) {
      throw invalidRequest(`\`ratio\` must be one of ${IMAGE_RATIOS.join(', ')}.`, { param: 'ratio', code: 'invalid_ratio' })
    }
  }
  const override = isImageRatio(ratioOverride) ? ratioOverride : undefined

  if (size === undefined || size === null || size === '' || size === 'auto') {
    return { tier: '1K', ratio: override ?? '1:1' }
  }
  if (typeof size !== 'string') {
    throw invalidRequest('`size` must be a string such as "1024x1024", "2K" or "auto".', { param: 'size', code: 'invalid_size' })
  }
  const trimmed = size.trim()
  if (isImageTier(trimmed)) return { tier: trimmed, ratio: override ?? '1:1' }

  const match = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(trimmed)
  if (!match) {
    throw invalidRequest(`Unsupported \`size\` value ${JSON.stringify(size)}. Use "1K"/"2K"/"3K"/"4K", "auto", or "WIDTHxHEIGHT".`, {
      param: 'size',
      code: 'invalid_size'
    })
  }
  const width = Number(match[1])
  const height = Number(match[2])
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw invalidRequest(`Invalid \`size\` value ${JSON.stringify(size)}.`, { param: 'size', code: 'invalid_size' })
  }

  const exact = EXACT_SIZE_LOOKUP.get(`${width}x${height}`)
  if (exact) return { tier: exact.tier, ratio: override ?? exact.ratio }
  return { tier: tierForLongestEdge(Math.max(width, height)), ratio: override ?? nearestRatio(width, height) }
}

export function parseImageCount(value: unknown): number {
  if (value === undefined || value === null || value === '') return 1
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : Number.NaN
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10) {
    throw invalidRequest('`n` must be an integer between 1 and 10.', { param: 'n', code: 'invalid_n' })
  }
  return parsed
}

export type ImageResponseFormat = 'url' | 'b64_json'

export function parseResponseFormat(value: unknown): ImageResponseFormat {
  if (value === undefined || value === null || value === '' || value === 'url') return 'url'
  if (value === 'b64_json') return 'b64_json'
  throw invalidRequest('`response_format` must be either "url" or "b64_json".', { param: 'response_format', code: 'invalid_response_format' })
}

function toNullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** Normalizes one upstream image item; empty strings become `null` per the OpenAI schema. */
export function normalizeImageItem(item: any): { url: string | null; b64_json: string | null; revised_prompt: string | null } {
  return {
    url: toNullableString(item?.url),
    b64_json: toNullableString(item?.b64_json),
    revised_prompt: toNullableString(item?.revised_prompt)
  }
}

export function assertPrompt(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw invalidRequest('`prompt` is required and must be a non-empty string.', { param: 'prompt', code: 'invalid_prompt' })
  }
  return value
}

export function collectImageInputs(body: Record<string, any>): string[] {
  const sources = [body.image, body.images, body.extra_body?.image]
  const images: string[] = []
  for (const source of sources) {
    if (source === undefined || source === null) continue
    const list = Array.isArray(source) ? source : [source]
    for (const item of list) {
      if (typeof item !== 'string' || item.trim().length === 0) {
        throw invalidRequest('`image` entries must be public image URLs or data URIs.', { param: 'image', code: 'invalid_image' })
      }
      images.push(item)
    }
  }
  return images
}
