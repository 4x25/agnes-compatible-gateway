import type { Hono } from 'hono'

export type AppEnv = {
  Variables: {
    agnesKey: string
  }
}

export type App = Hono<AppEnv>

export type JsonObject = Record<string, any>
