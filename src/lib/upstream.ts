import { ApiError, normalizeUpstreamError, upstreamNetworkError } from './errors.js'

export const TIMEOUT = {
  chat: 300_000,
  images: 180_000,
  video: 120_000,
  content: 120_000
} as const

export type UpstreamRequest = {
  url: string
  apiKey?: string
  /** Set to false to call a public asset URL without forwarding the API key. */
  auth?: boolean
  method?: string
  body?: string
  headers?: Record<string, string>
  timeoutMs?: number
  signal?: AbortSignal
}

/**
 * Calls the upstream Agnes API. The API key is only ever placed on the outgoing request
 * header; it is never written to disk, returned to clients or logged.
 */
export async function callUpstream(request: UpstreamRequest): Promise<Response> {
  const controller = new AbortController()
  let timedOut = false
  const timer =
    request.timeoutMs && request.timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true
          controller.abort()
        }, request.timeoutMs)
      : undefined

  const onExternalAbort = () => controller.abort()
  const externalSignal = request.signal
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort()
    else externalSignal.addEventListener('abort', onExternalAbort, { once: true })
  }

  try {
    return await fetch(request.url, {
      method: request.method ?? 'POST',
      headers: {
        ...(request.auth === false || !request.apiKey ? {} : { Authorization: `Bearer ${request.apiKey}` }),
        ...(request.body ? { 'Content-Type': 'application/json' } : {}),
        ...(request.headers ?? {})
      },
      body: request.body,
      signal: controller.signal
    })
  } catch (error) {
    if (timedOut) {
      throw upstreamNetworkError(504, `Upstream request timed out after ${request.timeoutMs}ms.`)
    }
    if (externalSignal?.aborted) {
      throw upstreamNetworkError(499, 'Client closed the request before the upstream responded.')
    }
    throw upstreamNetworkError(502, `Failed to reach the upstream service: ${describeNetworkError(error)}`)
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    externalSignal?.removeEventListener('abort', onExternalAbort)
  }
}

function describeNetworkError(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const cause = (error as { cause?: unknown }).cause
  const causeText =
    cause instanceof Error
      ? `${cause.name}${(cause as { code?: string }).code ? `:${(cause as { code?: string }).code}` : ''}: ${cause.message}`
      : cause !== undefined
        ? String(cause)
        : ''
  return causeText ? `${error.message} (cause: ${causeText})` : error.message
}

export async function upstreamErrorFrom(response: Response): Promise<ApiError> {
  let text = ''
  try {
    text = await response.text()
  } catch {
    text = ''
  }
  if (response.status === 499) return upstreamNetworkError(502, 'Upstream request was aborted.')
  return normalizeUpstreamError(response.status, text)
}

export async function readUpstreamJson(response: Response): Promise<any> {
  const text = await response.text()
  try {
    return JSON.parse(text)
  } catch {
    throw new ApiError(502, 'upstream_error', 'Upstream service returned a malformed JSON response.')
  }
}

export const SSE_HEADERS: Record<string, string> = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no'
}

export function streamResponse(body: ReadableStream<Uint8Array>, headers: Record<string, string> = {}): Response {
  return new Response(body, { status: 200, headers: { ...SSE_HEADERS, ...headers } })
}

/**
 * Forwards an upstream response to the client.
 *
 * JSON bodies are buffered (small, and some edge runtimes cannot hand a raw undici stream back
 * to the runtime's Response), while SSE keeps streaming through an identity transform.
 */
export async function passthroughResponse(upstream: Response): Promise<Response> {
  const contentType = upstream.headers.get('content-type') ?? 'application/json'
  const headers = { 'Content-Type': contentType }
  if (/text\/event-stream/i.test(contentType) && upstream.body) {
    return new Response(upstream.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>()), {
      status: upstream.status,
      headers
    })
  }
  const buffer = await upstream.arrayBuffer()
  return new Response(buffer, { status: upstream.status, headers })
}
