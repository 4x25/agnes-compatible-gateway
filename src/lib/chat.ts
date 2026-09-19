import { ApiError, invalidRequest } from './errors.js'
import type { JsonObject } from '../types.js'

const LEGACY_HINT =
  'Legacy `functions` / `function_call` are not supported by this gateway. ' +
  '请改用 `tools` 与 `tool_choice`（OpenAI 现行函数调用协议）。' +
  'Example: {"tools":[{"type":"function","function":{"name":"get_weather","parameters":{"type":"object","properties":{}}}}],"tool_choice":"auto"}'

const DEFAULT_PARAMETERS: JsonObject = { type: 'object', properties: {} }

/**
 * Minimal request rewrite for the adapted text model:
 * - rejects the deprecated `functions` / `function_call` protocol with an actionable error
 * - tolerates `function.parameters` being omitted by filling in an empty object schema
 * - rejects non-`function` tool types that the upstream cannot handle
 */
export function normalizeChatRequest(body: JsonObject): JsonObject {
  if (Array.isArray(body.functions) && body.functions.length > 0) throw invalidRequest(LEGACY_HINT, { param: 'functions', code: 'unsupported_legacy_protocol' })
  if (Object.prototype.hasOwnProperty.call(body, 'function_call')) throw invalidRequest(LEGACY_HINT, { param: 'function_call', code: 'unsupported_legacy_protocol' })

  const normalized: JsonObject = { ...body }

  if (Object.prototype.hasOwnProperty.call(body, 'tools') && body.tools !== undefined && body.tools !== null) {
    if (!Array.isArray(body.tools)) throw invalidRequest('`tools` must be an array.', { param: 'tools', code: 'invalid_tools' })
    normalized.tools = body.tools.map((tool: any, index: number) => {
      if (typeof tool !== 'object' || tool === null || Array.isArray(tool)) {
        throw invalidRequest(`\`tools[${index}]\` must be an object.`, { param: `tools[${index}]`, code: 'invalid_tools' })
      }
      if (tool.type !== 'function') {
        throw invalidRequest(
          `\`tools[${index}].type\` must be "function". Only function tools are supported by this gateway (received ${JSON.stringify(tool.type)}).`,
          { param: `tools[${index}].type`, code: 'unsupported_tool_type' }
        )
      }
      const fn = tool.function
      if (typeof fn !== 'object' || fn === null || Array.isArray(fn)) {
        throw invalidRequest(`\`tools[${index}].function\` must be an object.`, { param: `tools[${index}].function`, code: 'invalid_tools' })
      }
      return {
        ...tool,
        function: {
          ...fn,
          parameters: fn.parameters === undefined || fn.parameters === null ? { ...DEFAULT_PARAMETERS } : fn.parameters
        }
      }
    })
  }

  const hasToolChoice = Object.prototype.hasOwnProperty.call(body, 'tool_choice') && body.tool_choice !== undefined && body.tool_choice !== null
  if (hasToolChoice) {
    const tools = normalized.tools
    if (!Array.isArray(tools) || tools.length === 0) {
      throw invalidRequest("`tool_choice` is only allowed when `tools` are specified. 仅当传入 `tools` 时才可使用 `tool_choice`。", {
        param: 'tool_choice',
        code: 'invalid_tool_choice'
      })
    }
  }

  return normalized
}

const COMPLETION_FIELDS = ['id', 'object', 'created', 'model', 'choices', 'usage', 'service_tier', 'system_fingerprint'] as const
const CHOICE_FIELDS = ['index', 'finish_reason', 'message', 'logprobs'] as const
const MESSAGE_FIELDS = ['role', 'content', 'tool_calls', 'refusal', 'annotations', 'audio'] as const
const DELTA_FIELDS = ['role', 'content', 'tool_calls', 'refusal'] as const

function pick(source: JsonObject, fields: readonly string[]): JsonObject {
  const target: JsonObject = {}
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(source, field) && source[field] !== undefined) target[field] = source[field]
  }
  return target
}

function normalizeToolCall(toolCall: any, keepIndex: boolean): JsonObject {
  const normalized: JsonObject = {}
  if (keepIndex && typeof toolCall?.index === 'number') normalized.index = toolCall.index
  if (typeof toolCall?.id === 'string') normalized.id = toolCall.id
  normalized.type = typeof toolCall?.type === 'string' ? toolCall.type : 'function'
  const fn = toolCall?.function ?? {}
  normalized.function = {
    name: typeof fn.name === 'string' ? fn.name : '',
    arguments: typeof fn.arguments === 'string' ? fn.arguments : ''
  }
  return normalized
}

function normalizeToolCalls(toolCalls: any, keepIndex: boolean): JsonObject[] | undefined {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return undefined
  return toolCalls.map((toolCall) => normalizeToolCall(toolCall, keepIndex))
}

/** Strips non-standard upstream fields so responses match the OpenAI schema exactly. */
export function normalizeChatCompletion(payload: JsonObject): JsonObject {
  const normalized: JsonObject = pick(payload, COMPLETION_FIELDS)
  normalized.object = 'chat.completion'
  normalized.choices = Array.isArray(payload.choices)
    ? payload.choices.map((choice: any) => {
        const message = pick(choice?.message ?? {}, MESSAGE_FIELDS)
        const toolCalls = normalizeToolCalls(choice?.message?.tool_calls, false)
        if (toolCalls) {
          message.tool_calls = toolCalls
          if (message.content === '' || message.content === undefined) message.content = null
        } else if (message.content === undefined) {
          message.content = null
        }
        if (message.role === undefined) message.role = 'assistant'
        const normalizedChoice = pick(choice ?? {}, CHOICE_FIELDS)
        normalizedChoice.message = message
        return normalizedChoice
      })
    : []
  if (normalized.usage === undefined) delete normalized.usage
  return normalized
}

function normalizeDelta(delta: JsonObject): JsonObject {
  const normalized = pick(delta, DELTA_FIELDS)
  const toolCalls = normalizeToolCalls(delta.tool_calls, true)
  if (toolCalls) normalized.tool_calls = toolCalls
  return normalized
}

function isEmptyChoice(choice: JsonObject): boolean {
  const delta = choice?.delta ?? {}
  const hasContent = typeof delta.content === 'string' && delta.content.length > 0
  const hasToolCalls = Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0
  const hasRefusal = typeof delta.refusal === 'string' && delta.refusal.length > 0
  return !hasContent && !hasToolCalls && !hasRefusal && !choice?.finish_reason
}

/** Rewrites a single upstream SSE chunk into a strict OpenAI chunk (or drops it). */
export function normalizeChatChunk(payload: JsonObject, includeUsage: boolean): JsonObject | null {
  const choices: JsonObject[] = Array.isArray(payload.choices)
    ? payload.choices.map((choice: any) => {
        const normalizedChoice: JsonObject = pick(choice ?? {}, ['index', 'finish_reason', 'logprobs'])
        normalizedChoice.delta = normalizeDelta(choice?.delta ?? {})
        return normalizedChoice
      })
    : []

  const hasUsage = payload.usage !== undefined && payload.usage !== null
  const usageOnly = hasUsage && choices.every(isEmptyChoice)

  if (hasUsage && !includeUsage) {
    if (usageOnly) return null
    return { ...pick(payload, COMPLETION_FIELDS), object: 'chat.completion.chunk', choices }
  }

  if (usageOnly) {
    const normalized: JsonObject = pick(payload, ['id', 'object', 'created', 'model', 'service_tier', 'system_fingerprint'])
    normalized.object = 'chat.completion.chunk'
    normalized.choices = []
    normalized.usage = payload.usage
    return normalized
  }

  const normalized = pick(payload, COMPLETION_FIELDS)
  normalized.object = 'chat.completion.chunk'
  normalized.choices = choices
  if (hasUsage) normalized.usage = payload.usage
  return normalized
}

/**
 * Streaming SSE rewrite: each upstream event is parsed, normalized, and re-emitted.
 * The `[DONE]` sentinel is preserved and client disconnects propagate upstream.
 */
export function createSseNormalizer(options: { includeUsage: boolean }): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ''

  const processLine = (line: string): string | null => {
    if (line === '') return null
    if (line.startsWith(':')) return `${line}\n`
    if (!line.startsWith('data:')) return `${line}\n`

    const payloadText = line.slice(5).trim()
    if (payloadText === '[DONE]') return 'data: [DONE]\n\n'
    if (payloadText === '') return null

    let parsed: unknown
    try {
      parsed = JSON.parse(payloadText)
    } catch {
      return `${line}\n\n`
    }
    if (typeof parsed !== 'object' || parsed === null) return `${line}\n\n`

    const normalized = normalizeChatChunk(parsed as JsonObject, options.includeUsage)
    if (normalized === null) return null
    return `data: ${JSON.stringify(normalized)}\n\n`
  }

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true })
      let index = buffer.indexOf('\n')
      while (index !== -1) {
        const line = buffer.slice(0, index).replace(/\r$/, '')
        buffer = buffer.slice(index + 1)
        const output = processLine(line)
        if (output !== null) controller.enqueue(encoder.encode(output))
        index = buffer.indexOf('\n')
      }
    },
    flush(controller) {
      buffer += decoder.decode()
      if (buffer.length > 0) {
        const output = processLine(buffer.replace(/\r$/, ''))
        if (output !== null) controller.enqueue(encoder.encode(output))
      }
    }
  })
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError
}
