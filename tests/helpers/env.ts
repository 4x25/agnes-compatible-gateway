import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Minimal `.env` reader for live tests. Values are never printed by any test or report.
 */
export function loadDotEnv(): Record<string, string> {
  const path = join(process.cwd(), '.env')
  if (!existsSync(path)) return {}
  const values: Record<string, string> = {}
  for (const rawLine of readFileSync(path, 'utf8').split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const separator = line.indexOf('=')
    if (separator === -1) continue
    const key = line.slice(0, separator).trim()
    let value = line.slice(separator + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (key) values[key] = value
  }
  return values
}

export type LiveCredentials = {
  baseUrl?: string
  apiKey?: string
}

/**
 * Live suites read the upstream from `.env` (the gateway's own runtime config), falling back to
 * process env. `.env` wins so that the unit-test default base URL never leaks into live runs.
 */
export function liveCredentials(): LiveCredentials {
  const env = loadDotEnv()
  return {
    baseUrl: env.AGNES_BASE_URL ?? process.env.AGNES_BASE_URL,
    apiKey: env.AGNES_API_KEY_ONLY_FOR_TEST ?? process.env.AGNES_API_KEY
  }
}

/**
 * The shared test key is occasionally rate limited with a transient 401; retry with backoff.
 */
export async function withTransientRetry<T>(operation: () => Promise<T>, attempts = 5, delayMs = 2500): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs * attempt))
    }
  }
  throw lastError
}
