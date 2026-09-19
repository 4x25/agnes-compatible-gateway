import { invalidRequest } from './errors.js'
import type { JsonObject } from '../types.js'

export async function readJsonBody(request: Request): Promise<JsonObject> {
  let text: string
  try {
    text = await request.text()
  } catch {
    throw invalidRequest('Request body could not be read.')
  }
  if (!text.trim()) throw invalidRequest('Request body must be valid JSON.')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw invalidRequest('Request body must be valid JSON.')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw invalidRequest('Request body must be a JSON object.')
  }
  return parsed as JsonObject
}
