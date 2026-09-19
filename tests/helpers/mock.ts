import { vi } from 'vitest'

export type MockCall = {
  url: string
  method: string
  headers: Record<string, string>
  body: any
  rawBody: string | undefined
}

export type FetchMock = {
  calls: MockCall[]
  maxConcurrent: number
}

type Handler = (call: MockCall, index: number) => Response | Promise<Response>

export function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
}

export function textResponse(body: string, status = 200, contentType = 'application/json'): Response {
  return new Response(body, { status, headers: { 'content-type': contentType } })
}

export function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    }
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

export function installFetchMock(handler: Handler): FetchMock {
  const calls: MockCall[] = []
  const state = { active: 0, maxConcurrent: 0 }

  vi.stubGlobal('fetch', async (input: any, init: any = {}) => {
    const headers: Record<string, string> = {}
    const rawHeaders = init.headers ?? {}
    for (const [key, value] of Object.entries(rawHeaders)) headers[String(key).toLowerCase()] = String(value)
    const rawBody = typeof init.body === 'string' ? init.body : undefined
    let body: any = rawBody
    if (rawBody !== undefined) {
      try {
        body = JSON.parse(rawBody)
      } catch {
        body = rawBody
      }
    }
    const call: MockCall = {
      url: String(input),
      method: String(init.method ?? 'GET').toUpperCase(),
      headers,
      body,
      rawBody
    }
    calls.push(call)

    state.active += 1
    state.maxConcurrent = Math.max(state.maxConcurrent, state.active)
    try {
      return await handler(call, calls.length - 1)
    } finally {
      state.active -= 1
    }
  })

  return {
    calls,
    get maxConcurrent() {
      return state.maxConcurrent
    }
  }
}

export function proxyBaseUrl(): string {
  return process.env.AGNES_BASE_URL ?? 'https://upstream.test/v1'
}
