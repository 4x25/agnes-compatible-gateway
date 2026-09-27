import type { Context } from 'hono'
import { resolveUpstreamConfig } from '../lib/config.js'
import { callUpstream, passthroughResponse, TIMEOUT, upstreamErrorFrom } from '../lib/upstream.js'
import type { AppEnv } from '../types.js'

export async function listModels(c: Context<AppEnv>): Promise<Response> {
  const { baseUrl } = resolveUpstreamConfig(c.env, c.get('agnesBaseUrl'))
  const upstream = await callUpstream({
    url: `${baseUrl}/models`,
    method: 'GET',
    apiKey: c.get('agnesKey'),
    timeoutMs: TIMEOUT.video,
    signal: c.req.raw.signal
  })
  if (!upstream.ok) throw await upstreamErrorFrom(upstream)
  return passthroughResponse(upstream)
}
