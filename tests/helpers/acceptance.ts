import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { liveCredentials } from './env.js'

export type AcceptanceContext = {
  enabled: boolean
  target: string
  apiKey: string
}

/**
 * Acceptance runs against a deployed gateway over plain HTTP.
 * Enabled with AGNES_ACCEPT=1; target defaults to the production Wasmer app.
 */
export function acceptanceContext(): AcceptanceContext {
  const credentials = liveCredentials()
  const target = (process.env.AGNES_ACCEPT_TARGET ?? 'https://agnes.wasmer.app').replace(/\/+$/, '')
  const enabled = process.env.AGNES_ACCEPT === '1' && Boolean(credentials.apiKey)
  return { enabled, target, apiKey: credentials.apiKey ?? '' }
}

const RESULTS_DIR = join(process.cwd(), 'docs', 'test-results')

export function recordAcceptance(entry: Record<string, unknown>): void {
  const path = join(RESULTS_DIR, 'acceptance.jsonl')
  mkdirSync(RESULTS_DIR, { recursive: true })
  appendFileSync(path, `${JSON.stringify({ recorded_at: new Date().toISOString(), ...entry })}\n`)
}

export function authHeaders(apiKey: string): Record<string, string> {
  return { authorization: `Bearer ${apiKey}` }
}

export async function readJson(response: Response): Promise<any> {
  const text = await response.text()
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text.slice(0, 500) }
  }
}
