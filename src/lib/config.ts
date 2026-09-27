export const DEFAULT_AGNES_BASE_URL = 'https://apihub.agnes-ai.com/v1'

/** Models that get a full OpenAI-compatible adaptation. Everything else is proxied as-is. */
export const ADAPTED_TEXT_MODEL = 'agnes-3.0-flash'
export const ADAPTED_IMAGE_MODEL = 'agnes-image-2.5-flash'
export const ADAPTED_VIDEO_MODEL = 'agnes-video-2.5-flash'

export const ADAPTED_MODELS = [
  ADAPTED_TEXT_MODEL,
  ADAPTED_IMAGE_MODEL,
  ADAPTED_VIDEO_MODEL
] as const

export type UpstreamConfig = {
  baseUrl: string
  queryUrl: string
}

/**
 * Agnes exposes the asynchronous video lookup on `<origin><prefix>/agnesapi`, while every
 * other endpoint lives under `<origin><prefix>/v1`. The lookup URL is therefore derived by
 * dropping the trailing `/v1` segment.
 */
export function deriveQueryUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  const withoutVersion = trimmed.replace(/\/v1$/, '')
  return `${withoutVersion}/agnesapi`
}

function readEnv(env: unknown, name: string): string | undefined {
  if (env && typeof env === 'object') {
    const value = (env as Record<string, unknown>)[name]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  if (typeof process !== 'undefined' && process.env) {
    const value = process.env[name]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return undefined
}

/**
 * Resolves the upstream base. A dynamic base extracted from the request path always wins over
 * the `AGNES_BASE_URL` environment variable; blank values fall through to the env/default.
 */
export function resolveUpstreamConfig(env: unknown, dynamicBaseUrl?: string): UpstreamConfig {
  const rawBase = dynamicBaseUrl?.trim() || readEnv(env, 'AGNES_BASE_URL') || DEFAULT_AGNES_BASE_URL
  const baseUrl = rawBase.replace(/\/+$/, '')
  return { baseUrl, queryUrl: deriveQueryUrl(baseUrl) }
}
