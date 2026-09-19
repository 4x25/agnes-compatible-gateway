export type OpenAiErrorType =
  | 'invalid_request_error'
  | 'authentication_error'
  | 'rate_limit_error'
  | 'api_error'
  | 'upstream_error'

export type ErrorBody = {
  error: {
    message: string
    type: string
    param: string | null
    code: string
  }
}

export class ApiError extends Error {
  readonly status: number
  readonly type: string
  readonly param: string | null
  readonly code: string
  readonly headers: Record<string, string>

  constructor(
    status: number,
    type: string,
    message: string,
    options: { param?: string | null; code?: string; headers?: Record<string, string> } = {}
  ) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.type = type
    this.param = options.param ?? null
    this.code = options.code ?? ''
    this.headers = options.headers ?? {}
  }
}

export function invalidRequest(message: string, options: { param?: string | null; code?: string } = {}): ApiError {
  return new ApiError(400, 'invalid_request_error', message, options)
}

export function unauthorized(message = 'Missing or invalid Authorization header. Expected: Authorization: Bearer <Agnes API key>.'): ApiError {
  return new ApiError(401, 'authentication_error', message, { headers: { 'WWW-Authenticate': 'Bearer' } })
}

export function errorBody(error: ApiError): ErrorBody {
  return {
    error: {
      message: error.message,
      type: error.type,
      param: error.param,
      code: error.code
    }
  }
}

export function typeForStatus(status: number): string {
  if (status === 401 || status === 403) return 'authentication_error'
  if (status === 429) return 'rate_limit_error'
  if (status >= 500) return 'api_error'
  return 'invalid_request_error'
}

type ExtractedError = {
  message: string
  code: string
  param: string | null
  type?: string
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Unwraps the `***.BadRequestError: OpenAIException - {...}` envelopes some upstream queues return. */
function unwrapMessage(raw: string): string {
  const marker = 'OpenAIException - '
  const index = raw.indexOf(marker)
  if (index === -1) return raw
  const tail = raw.slice(index + marker.length).trim()
  const start = tail.indexOf('{')
  if (start === -1) return raw
  const parsed = tryParse(tail.slice(start))
  if (!isRecord(parsed)) return raw
  const inner = typeof parsed.message === 'string' ? parsed.message : undefined
  if (!inner) return raw
  const prefix = raw.slice(0, index).trim()
  return prefix ? `${prefix} ${inner}` : inner
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function extractError(rawText: string): ExtractedError {
  const text = (rawText ?? '').trim()
  if (!text) {
    return { message: 'Upstream service returned an empty error response.', code: '', param: null }
  }

  const parsed = tryParse(text)
  if (!isRecord(parsed)) {
    return { message: unwrapMessage(text), code: '', param: null }
  }

  const candidates: Array<Record<string, any>> = []
  if (isRecord(parsed.error)) candidates.push(parsed.error)
  if (typeof parsed.error === 'string') candidates.push({ message: parsed.error })
  if (isRecord(parsed.detail)) candidates.push(parsed.detail)
  candidates.push(parsed)

  for (const candidate of candidates) {
    const detail = candidate.detail
    if (typeof detail === 'string' && detail.trim()) {
      return {
        message: detail.trim(),
        code: stringifyCode(candidate.code),
        param: typeof candidate.param === 'string' ? candidate.param : null
      }
    }
    if (Array.isArray(detail) && detail.length > 0) {
      const messages = detail
        .map((item) => (isRecord(item) ? (typeof item.msg === 'string' ? item.msg : JSON.stringify(item)) : String(item)))
        .join('; ')
      return { message: messages, code: stringifyCode(candidate.code), param: null }
    }
    if (typeof candidate.message === 'string' && candidate.message.trim()) {
      const message = unwrapMessage(candidate.message.trim())
      return {
        message,
        code: stringifyCode(candidate.code),
        param: typeof candidate.param === 'string' ? candidate.param : null,
        type: typeof candidate.type === 'string' ? candidate.type : undefined
      }
    }
  }

  return { message: unwrapMessage(text), code: '', param: null }
}

function stringifyCode(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  return ''
}

export function normalizeUpstreamError(status: number, rawText: string): ApiError {
  const extracted = extractError(rawText)
  return new ApiError(status, typeForStatus(status), extracted.message, {
    code: extracted.code,
    param: extracted.param
  })
}

export function upstreamNetworkError(status: number, message: string): ApiError {
  return new ApiError(status, 'upstream_error', message)
}
