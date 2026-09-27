import { Hono, type Context } from 'hono'
import { cors } from 'hono/cors'
import { ApiError, errorBody, unauthorized } from './lib/errors.js'
import { parseDynamicBase } from './lib/dynamic-base.js'
import { Page } from './page.js'
import { chatCompletions } from './routes/chat.js'
import { createImage, editImage } from './routes/images.js'
import { createVideo, getVideo, getVideoContent } from './routes/videos.js'
import { listModels } from './routes/models.js'
import type { AppEnv } from './types.js'

type RouteHandler = (c: Context<AppEnv>) => Promise<Response>

/**
 * Terminal handlers addressable through a dynamic base URL path
 * (e.g. `/https://upstream.example.com/v1/chat/completions`), keyed by method + gateway route.
 */
const DYNAMIC_ROUTES: Record<string, RouteHandler> = {
  'POST /v1/chat/completions': chatCompletions,
  'POST /v1/images/generations': createImage,
  'POST /v1/images/edits': editImage,
  'GET /v1/models': listModels,
  'POST /v1/videos': createVideo,
  'GET /v1/videos/:video_id': getVideo,
  'GET /v1/videos/:video_id/content': getVideoContent
}

function requireApiKey(c: Context<AppEnv>): void {
  const header = c.req.header('authorization') ?? ''
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  const key = match?.[1]?.trim()
  if (!key) throw unauthorized()
  c.set('agnesKey', key)
}

/**
 * The gateway's own public origin, used by the docs page. Prefers the Host header
 * (what the browser actually asked for) and only keeps values that look like a host.
 */
function gatewayOrigin(c: Context): string {
  const url = new URL(c.req.url)
  const hostHeader = c.req.header('host') ?? ''
  const host = /^[A-Za-z0-9.\-:\[\]]+$/.test(hostHeader) ? hostHeader : url.host
  const forwardedProto = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim()
  const protocol = forwardedProto === 'http' || forwardedProto === 'https' ? forwardedProto : url.protocol.replace(':', '')
  return `${protocol}://${host}`
}

function logRequest(method: string, path: string, status: number, durationMs: number, streaming: boolean): void {
  if (process.env.NODE_ENV === 'test') return
  // Only method/path/status/duration are logged: never bodies, headers or credentials.
  console.log(JSON.stringify({ level: 'info', msg: 'request', method, path, status, duration_ms: durationMs, stream: streaming }))
}

export function createApp() {
  const app = new Hono<AppEnv>()

  app.use(
    '*',
    cors({
      origin: '*',
      allowMethods: ['GET', 'POST', 'OPTIONS'],
      allowHeaders: ['Authorization', 'Content-Type'],
      maxAge: 86400
    })
  )

  app.use('*', async (c, next) => {
    const startedAt = Date.now()
    await next()
    const contentType = c.res.headers.get('content-type') ?? ''
    logRequest(c.req.method, c.req.path, c.res.status, Date.now() - startedAt, contentType.includes('text/event-stream'))
  })

  app.use('/v1/*', async (c, next) => {
    requireApiKey(c)
    await next()
  })

  // Dynamic base URL: `/https://upstream.example.com/v1/...` proxies to that upstream base,
  // overriding `AGNES_BASE_URL`, while reusing the exact same terminal handlers.
  app.use('*', async (c, next) => {
    const dynamic = parseDynamicBase(c.req.path)
    if (!dynamic) {
      await next()
      return
    }
    const handler = DYNAMIC_ROUTES[`${c.req.method} ${dynamic.routePath}`]
    if (!handler) {
      await next()
      return
    }
    requireApiKey(c)
    c.set('agnesBaseUrl', dynamic.baseUrl)
    if (dynamic.videoId !== undefined) c.set('videoId', dynamic.videoId)
    return handler(c)
  })

  app.get('/', (c) => c.html(Page({ origin: gatewayOrigin(c) })))
  app.get('/v1/models', listModels)
  app.post('/v1/chat/completions', chatCompletions)
  app.post('/v1/images/generations', createImage)
  app.post('/v1/images/edits', editImage)
  app.post('/v1/videos', createVideo)
  app.get('/v1/videos/:video_id', getVideo)
  app.get('/v1/videos/:video_id/content', getVideoContent)

  app.notFound((c) =>
    c.json(
      { error: { message: `Not found: ${c.req.method} ${c.req.path}`, type: 'invalid_request_error', param: null, code: 'not_found' } },
      404
    )
  )

  app.onError((error, c) => {
    if (error instanceof ApiError) {
      if (error.status === 499) {
        return c.json(errorBody(new ApiError(502, 'upstream_error', 'Upstream request was aborted.')), 502)
      }
      return c.json(errorBody(error), error.status as 400, error.headers)
    }
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'unhandled_error',
        name: error instanceof Error ? error.name : 'UnknownError',
        message: error instanceof Error ? error.message : String(error)
      })
    )
    return c.json({ error: { message: 'Internal gateway error.', type: 'api_error', param: null, code: 'internal_error' } }, 500)
  })

  return app
}
