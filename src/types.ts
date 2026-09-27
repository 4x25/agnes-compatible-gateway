import type { Hono } from 'hono'

export type AppEnv = {
  Variables: {
    agnesKey: string
    /** Upstream base extracted from a dynamic base URL path; takes priority over `AGNES_BASE_URL`. */
    agnesBaseUrl?: string
    /** Raw video id captured from a dynamic base URL path. */
    videoId?: string
  }
}

export type App = Hono<AppEnv>

export type JsonObject = Record<string, any>
