import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createApp } from '../../src/app.js'
import { liveCredentials } from './env.js'

export type LiveContext = {
  enabled: boolean
  app: ReturnType<typeof createApp>
  apiKey: string
  baseUrl: string
  reason?: string
}

export function liveContext(): LiveContext {
  const credentials = liveCredentials()
  const enabled = process.env.AGNES_LIVE === '1' && Boolean(credentials.baseUrl) && Boolean(credentials.apiKey)
  if (enabled) {
    // The gateway reads the upstream base from the environment on every request.
    process.env.AGNES_BASE_URL = credentials.baseUrl
  }
  return {
    enabled,
    app: createApp(),
    apiKey: credentials.apiKey ?? '',
    baseUrl: credentials.baseUrl ?? '',
    reason: enabled ? undefined : 'AGNES_LIVE=1 与 .env 中的联调凭据齐备时才会执行真实上游用例'
  }
}

const RESULTS_DIR = join(process.cwd(), 'docs', 'test-results')

/** Appends raw evidence for the Chinese test report (never contains credentials). */
export function recordResult(fileName: string, entry: Record<string, unknown>): void {
  const path = join(RESULTS_DIR, fileName)
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, `${JSON.stringify({ recorded_at: new Date().toISOString(), ...entry })}\n`)
}

export function dataUriImage(): string {
  // Minimal valid 8x8 red PNG used for vision / image-edit live checks.
  const base64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP8z4APMOGVHbHSAEEsAROxmI4sAAAAAElFTkSuQmCC'
  return `data:image/png;base64,${base64}`
}

export async function readJson(response: Response): Promise<any> {
  const text = await response.text()
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text.slice(0, 500) }
  }
}
