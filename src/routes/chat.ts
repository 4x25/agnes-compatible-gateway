import type { Context } from 'hono'
import { ADAPTED_TEXT_MODEL, resolveUpstreamConfig } from '../lib/config.js'
import { readJsonBody } from '../lib/body.js'
import { createSseNormalizer, normalizeChatCompletion, normalizeChatRequest } from '../lib/chat.js'
import { callUpstream, passthroughResponse, readUpstreamJson, SSE_HEADERS, TIMEOUT, upstreamErrorFrom } from '../lib/upstream.js'
import type { AppEnv, JsonObject } from '../types.js'

export async function chatCompletions(c: Context<AppEnv>): Promise<Response> {
  const { baseUrl } = resolveUpstreamConfig(c.env, c.get('agnesBaseUrl'))
  const apiKey = c.get('agnesKey')
  const body = await readJsonBody(c.req.raw)
  const model = typeof body.model === 'string' ? body.model : ''
  const url = `${baseUrl}/chat/completions`

  if (model !== ADAPTED_TEXT_MODEL) {
    const upstream = await callUpstream({
      url,
      apiKey,
      body: JSON.stringify(body),
      timeoutMs: TIMEOUT.chat,
      signal: c.req.raw.signal
    })
    if (!upstream.ok) throw await upstreamErrorFrom(upstream)
    return passthroughResponse(upstream)
  }

  const normalizedRequest: JsonObject = normalizeChatRequest(body)
  const streaming = normalizedRequest.stream === true
  const includeUsage = normalizedRequest.stream_options?.include_usage === true

  const upstream = await callUpstream({
    url,
    apiKey,
    body: JSON.stringify(normalizedRequest),
    timeoutMs: streaming ? undefined : TIMEOUT.chat,
    signal: c.req.raw.signal
  })
  if (!upstream.ok) throw await upstreamErrorFrom(upstream)

  if (streaming) {
    if (!upstream.body) {
      return new Response('data: [DONE]\n\n', { status: 200, headers: SSE_HEADERS })
    }
    const stream = upstream.body.pipeThrough(createSseNormalizer({ includeUsage }))
    return new Response(stream, { status: 200, headers: SSE_HEADERS })
  }

  const payload = await readUpstreamJson(upstream)
  return Response.json(normalizeChatCompletion(payload))
}
