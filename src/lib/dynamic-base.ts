/**
 * Dynamic upstream base URL support.
 *
 * A caller may prefix the upstream base URL onto the gateway URL and use the result as an
 * OpenAI `base_url`, e.g. `https://example.com/https://upstream.example.com/v1`. The gateway
 * then forwards to `https://upstream.example.com/v1` instead of the configured
 * `AGNES_BASE_URL`, while everything else (auth, adaptation, body) stays the same.
 *
 * Edge CDNs (Cloudflare and friends) collapse duplicate slashes in the path, so the scheme
 * separator arrives as `https:/upstream...` instead of `https://upstream...`. `parseDynamicBase`
 * restores it before extracting the upstream base.
 */
export type DynamicBaseMatch = {
  /** Upstream base URL extracted from the path, e.g. `https://upstream.example.com/v1`. */
  baseUrl: string
  /** Gateway endpoint that the caller actually addressed, e.g. `/v1/chat/completions`. */
  routePath: string
  /** Raw (still URL-encoded) video id when the addressed endpoint carries one. */
  videoId?: string
}

type Endpoint = {
  pattern: RegExp
  routePath: string
  captureVideoId?: boolean
}

const ENDPOINTS: Endpoint[] = [
  { pattern: /\/chat\/completions$/, routePath: '/v1/chat/completions' },
  { pattern: /\/images\/generations$/, routePath: '/v1/images/generations' },
  { pattern: /\/images\/edits$/, routePath: '/v1/images/edits' },
  { pattern: /\/models$/, routePath: '/v1/models' },
  { pattern: /\/videos$/, routePath: '/v1/videos' },
  { pattern: /\/videos\/([^/]+)\/content$/, routePath: '/v1/videos/:video_id/content', captureVideoId: true },
  { pattern: /\/videos\/([^/]+)$/, routePath: '/v1/videos/:video_id', captureVideoId: true }
]

/** True only for absolute http(s) URLs with a host, which is all the gateway is willing to proxy to. */
export function isValidBaseUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname.length > 0
  } catch {
    return false
  }
}

/**
 * Returns the dynamic upstream base when `rawPath` embeds one, otherwise `null`.
 * Never throws: malformed input simply falls through to the normal routes.
 */
export function parseDynamicBase(rawPath: string): DynamicBaseMatch | null {
  if (!/^\/(https?):/i.test(rawPath)) return null

  // Undo CDN duplicate-slash collapsing: /https:/upstream -> /https://upstream.
  const path = rawPath.replace(/^\/(https?):\/+/i, (_match, scheme: string) => `/${scheme}://`)

  for (const endpoint of ENDPOINTS) {
    const match = endpoint.pattern.exec(path)
    if (!match) continue

    const baseUrl = path.slice(0, match.index).replace(/^\/+/, '')
    if (!isValidBaseUrl(baseUrl)) return null

    return {
      baseUrl,
      routePath: endpoint.routePath,
      videoId: endpoint.captureVideoId ? match[1] : undefined
    }
  }

  return null
}
