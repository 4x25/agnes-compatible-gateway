import type { Context } from 'hono'
import { ADAPTED_IMAGE_MODEL, resolveUpstreamConfig } from '../lib/config.js'
import { readJsonBody } from '../lib/body.js'
import { mapWithConcurrency } from '../lib/concurrency.js'
import { invalidRequest } from '../lib/errors.js'
import {
  assertPrompt,
  collectImageInputs,
  normalizeImageItem,
  parseImageCount,
  parseResponseFormat,
  resolveImageSize,
  type ImageResponseFormat,
  type ResolvedImageSize
} from '../lib/images.js'
import { callUpstream, passthroughResponse, readUpstreamJson, TIMEOUT, upstreamErrorFrom } from '../lib/upstream.js'
import type { AppEnv } from '../types.js'

const MAX_FANOUT_CONCURRENCY = 4

type GenerationPlan = {
  model: string
  prompt: string
  size: ResolvedImageSize
  images: string[]
  responseFormat: ImageResponseFormat
  returnBase64?: boolean
  n: number
}

function buildUpstreamBody(plan: GenerationPlan): string {
  const extraBody: Record<string, unknown> = { response_format: plan.responseFormat }
  if (plan.images.length > 0) extraBody.image = plan.images

  const body: Record<string, unknown> = {
    model: plan.model,
    prompt: plan.prompt,
    size: plan.size.tier,
    ratio: plan.size.ratio,
    extra_body: extraBody
  }
  if (plan.returnBase64 === true) body.return_base64 = true
  return JSON.stringify(body)
}

/**
 * Fans `n` requests out to the upstream (which only accepts n=1) with bounded concurrency and
 * atomic semantics: any failed sub-request fails the whole call, no partial result is returned.
 */
async function runGenerationPlan(c: Context<AppEnv>, plan: GenerationPlan): Promise<Response> {
  const { baseUrl } = resolveUpstreamConfig(c.env)
  const apiKey = c.get('agnesKey')
  const payloadText = buildUpstreamBody(plan)

  const payloads = await mapWithConcurrency(plan.n, Math.min(MAX_FANOUT_CONCURRENCY, plan.n), async (_index, signal) => {
    const upstream = await callUpstream({
      url: `${baseUrl}/images/generations`,
      apiKey,
      body: payloadText,
      timeoutMs: TIMEOUT.images,
      signal
    })
    if (!upstream.ok) throw await upstreamErrorFrom(upstream)
    return readUpstreamJson(upstream)
  })

  const data = plan.n === 1 ? asItems(payloads[0]) : payloads.map(asSingleItem)
  const created = payloads.map((payload) => (typeof payload?.created === 'number' ? payload.created : undefined)).find((value) => value !== undefined)

  return c.json(
    {
      created: created ?? Math.floor(Date.now() / 1000),
      data
    },
    200
  )
}

function asItems(payload: any): Array<{ url: string | null; b64_json: string | null; revised_prompt: string | null }> {
  if (Array.isArray(payload?.data)) return payload.data.map(normalizeImageItem)
  if (payload?.data && typeof payload.data === 'object') return [normalizeImageItem(payload.data)]
  return []
}

function asSingleItem(payload: any): { url: string | null; b64_json: string | null; revised_prompt: string | null } {
  return asItems(payload)[0] ?? { url: null, b64_json: null, revised_prompt: null }
}

function isAdaptedModel(model: unknown): boolean {
  return model === ADAPTED_IMAGE_MODEL
}

export async function createImage(c: Context<AppEnv>): Promise<Response> {
  const { baseUrl } = resolveUpstreamConfig(c.env)
  const apiKey = c.get('agnesKey')
  const body = await readJsonBody(c.req.raw)
  const model = typeof body.model === 'string' ? body.model : ''

  if (!isAdaptedModel(model)) {
    const upstream = await callUpstream({
      url: `${baseUrl}/images/generations`,
      apiKey,
      body: JSON.stringify(body),
      timeoutMs: TIMEOUT.images,
      signal: c.req.raw.signal
    })
    if (!upstream.ok) throw await upstreamErrorFrom(upstream)
    return passthroughResponse(upstream)
  }

  const prompt = assertPrompt(body.prompt)
  const size = resolveImageSize(body.size, body.ratio)
  const n = parseImageCount(body.n)
  const responseFormat = parseResponseFormat(body.response_format)
  const images = collectImageInputs(body)
  const explicitReturnBase64 = typeof body.return_base64 === 'boolean' ? body.return_base64 : undefined

  return runGenerationPlan(c, {
    model,
    prompt,
    size,
    images,
    responseFormat,
    returnBase64: explicitReturnBase64 ?? (responseFormat === 'b64_json' && images.length === 0 ? true : undefined),
    n
  })
}

function formValue(form: FormData, name: string): string | undefined {
  const value = form.get(name)
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

async function fileToDataUri(file: File): Promise<string> {
  const buffer = Buffer.from(await file.arrayBuffer())
  const mime = file.type && file.type.startsWith('image/') ? file.type : 'image/png'
  return `data:${mime};base64,${buffer.toString('base64')}`
}

export async function editImage(c: Context<AppEnv>): Promise<Response> {
  const contentType = c.req.header('content-type') ?? ''
  const warnings: string[] = []

  let model = ''
  let prompt = ''
  let size: unknown
  let ratio: unknown
  let n: unknown
  let responseFormat: unknown
  let returnBase64: unknown
  const images: string[] = []

  if (/multipart\/form-data/i.test(contentType)) {
    let form: FormData
    try {
      form = await c.req.raw.formData()
    } catch {
      throw invalidRequest('Request body must be valid multipart/form-data.')
    }
    model = formValue(form, 'model') ?? ''
    prompt = formValue(form, 'prompt') ?? ''
    size = formValue(form, 'size')
    ratio = formValue(form, 'ratio')
    n = formValue(form, 'n')
    responseFormat = formValue(form, 'response_format')
    const returnBase64Raw = formValue(form, 'return_base64')
    if (returnBase64Raw !== undefined) returnBase64 = returnBase64Raw === 'true'

    const fileFields = ['image', 'image[]', 'images']
    for (const field of fileFields) {
      for (const entry of form.getAll(field)) {
        if (typeof entry === 'string') {
          if (entry.trim().length > 0) images.push(entry)
        } else {
          images.push(await fileToDataUri(entry))
        }
      }
    }
    if (form.get('mask') !== null) {
      warnings.push('`mask` is not supported by the upstream image model and was ignored.')
    }
  } else {
    const body = await readJsonBody(c.req.raw)
    model = typeof body.model === 'string' ? body.model : ''
    prompt = typeof body.prompt === 'string' ? body.prompt : ''
    size = body.size
    ratio = body.ratio
    n = body.n
    responseFormat = body.response_format
    returnBase64 = body.return_base64
    for (const field of ['image', 'image[]', 'images']) {
      const raw = body[field]
      if (raw === undefined || raw === null) continue
      for (const entry of Array.isArray(raw) ? raw : [raw]) {
        if (typeof entry !== 'string' || entry.trim().length === 0) {
          throw invalidRequest('`image` entries must be public image URLs or data URIs.', { param: field, code: 'invalid_image' })
        }
        images.push(entry)
      }
    }
    if (body.mask !== undefined && body.mask !== null) {
      warnings.push('`mask` is not supported by the upstream image model and was ignored.')
    }
  }

  if (!isAdaptedModel(model)) {
    throw invalidRequest(
      `\`/v1/images/edits\` only supports \`${ADAPTED_IMAGE_MODEL}\` on this gateway. Received ${JSON.stringify(model)}. 该端点仅适配 ${ADAPTED_IMAGE_MODEL}。`,
      { param: 'model', code: 'model_not_supported' }
    )
  }
  if (images.length === 0) {
    throw invalidRequest('`image` is required for image edits: upload a file or pass a public URL / data URI.', {
      param: 'image',
      code: 'missing_image'
    })
  }

  const plan: GenerationPlan = {
    model,
    prompt: assertPrompt(prompt),
    size: resolveImageSize(size, ratio),
    images,
    responseFormat: parseResponseFormat(responseFormat),
    returnBase64: typeof returnBase64 === 'boolean' ? returnBase64 : undefined,
    n: parseImageCount(n)
  }

  const response = await runGenerationPlan(c, plan)
  if (warnings.length > 0) response.headers.set('x-agnes-warning', warnings.join(' '))
  return response
}
