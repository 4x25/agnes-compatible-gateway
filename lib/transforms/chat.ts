import { invalidRequest } from "../errors.ts";
import { isJsonObject } from "../http.ts";
import type { JsonObject } from "../types.ts";
import {
  collectUnknownFields,
  optionalBoolean,
  optionalFiniteNumber,
  optionalInteger,
  optionalObject,
  requireNonEmptyString,
} from "./shared.ts";

const CHAT_FIELDS = new Set([
  "model",
  "messages",
  "temperature",
  "top_p",
  "max_tokens",
  "max_completion_tokens",
  "stream",
  "tools",
  "tool_choice",
  "chat_template_kwargs",
  "thinking",
]);

const MESSAGE_ROLES = new Set([
  "system",
  "developer",
  "user",
  "assistant",
  "tool",
]);

// Agnes documents `role`/`content` for every message and the OpenAI tool-call
// continuation fields used by Agnes 3.0 Flash. Keeping the allowlist at the
// message boundary is important: OpenAI clients may attach metadata, audio,
// refusal, or other objects which Agnes has not documented and which may
// contain sensitive caller data.
const MESSAGE_FIELDS = new Set([
  "role",
  "content",
  "tool_calls",
  "tool_call_id",
]);

const TOOL_CALL_FIELDS = new Set(["id", "type", "function"]);
const TOOL_FUNCTION_FIELDS = new Set(["name", "arguments"]);

export interface TransformedChatRequest {
  body: JsonObject;
  ignored: Set<string>;
  stream: boolean;
}

/** Convert the supported OpenAI Chat Completions subset to Agnes. */
export function transformChatRequest(
  input: JsonObject,
  ignoredParams?: Set<string>,
): TransformedChatRequest {
  const ignored = ignoredParams ?? new Set<string>();
  for (const field of collectUnknownFields(input, CHAT_FIELDS)) {
    ignored.add(field);
  }
  const body: JsonObject = {
    model: requireNonEmptyString(input, "model"),
    messages: transformMessages(input.messages, ignored),
  };

  for (const name of ["temperature", "top_p"] as const) {
    const value = optionalFiniteNumber(input, name);
    if (value !== undefined) body[name] = value;
  }

  const completionMax = optionalInteger(input, "max_completion_tokens");
  const legacyMax = completionMax === undefined
    ? optionalInteger(input, "max_tokens")
    : undefined;
  const maxTokens = completionMax ?? legacyMax;
  if (maxTokens !== undefined) {
    if (maxTokens <= 0) {
      throw invalidRequest(
        "The token limit must be greater than zero.",
        completionMax !== undefined ? "max_completion_tokens" : "max_tokens",
      );
    }
    body.max_tokens = maxTokens;
  }
  if (completionMax !== undefined && input.max_tokens !== undefined) {
    ignored.add("max_tokens");
  }

  const stream = optionalBoolean(input, "stream") ?? false;
  if (input.stream !== undefined) body.stream = stream;

  if (input.tools !== undefined) {
    if (!Array.isArray(input.tools)) {
      throw invalidRequest("'tools' must be an array.", "tools");
    }
    body.tools = input.tools;
  }
  if (input.tool_choice !== undefined) {
    if (
      typeof input.tool_choice !== "string" &&
      !isJsonObject(input.tool_choice)
    ) {
      throw invalidRequest(
        "'tool_choice' must be a string or object.",
        "tool_choice",
      );
    }
    body.tool_choice = input.tool_choice;
  }

  for (const name of ["chat_template_kwargs", "thinking"] as const) {
    const value = optionalObject(input, name);
    if (value !== undefined) body[name] = value;
  }

  return { body, ignored, stream };
}

function transformMessages(value: unknown, ignored: Set<string>): JsonObject[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw invalidRequest("'messages' must be a non-empty array.", "messages");
  }

  return value.map((message, index) => {
    const param = `messages.${index}`;
    if (!isJsonObject(message)) {
      throw invalidRequest(`'${param}' must be an object.`, param);
    }
    for (const field of collectUnknownFields(message, MESSAGE_FIELDS)) {
      ignored.add(`${param}.${field}`);
    }
    const role = message.role;
    if (typeof role !== "string" || !MESSAGE_ROLES.has(role)) {
      throw invalidRequest(
        `'${param}.role' is not supported.`,
        `${param}.role`,
      );
    }

    if (role === "tool") {
      return transformToolResultMessage(message, param, ignored);
    }

    if (message.tool_call_id !== undefined) {
      ignored.add(`${param}.tool_call_id`);
    }
    const toolCalls = role === "assistant"
      ? transformToolCalls(message.tool_calls, `${param}.tool_calls`, ignored)
      : undefined;
    if (role !== "assistant" && message.tool_calls !== undefined) {
      ignored.add(`${param}.tool_calls`);
    }

    // An assistant continuation message may carry only tool calls, which is
    // the OpenAI shape Agnes 3.0 Flash accepts for the tool-result round trip.
    const nullContentAllowed = toolCalls !== undefined && toolCalls.length > 0;
    if (message.content === undefined) {
      throw invalidRequest(
        `'${param}.content' is required.`,
        `${param}.content`,
      );
    }
    if (message.content === null) {
      if (!nullContentAllowed) {
        throw invalidRequest(
          `'${param}.content' may be null only for an assistant message with tool calls.`,
          `${param}.content`,
        );
      }
      const result: JsonObject = { role, content: null };
      result.tool_calls = toolCalls;
      return result;
    }
    if (
      typeof message.content !== "string" && !Array.isArray(message.content)
    ) {
      throw invalidRequest(
        `'${param}.content' must be a string or array.`,
        `${param}.content`,
      );
    }

    // Agnes currently names the highest-priority instruction role `system`.
    // Build a new object from the documented fields instead of spreading the
    // caller object, so unsupported nested values never reach the upstream.
    const content = Array.isArray(message.content)
      ? transformContentParts(message.content, `${param}.content`, ignored)
      : message.content;
    const result: JsonObject = {
      role: message.role === "developer" ? "system" : message.role,
      content,
    };
    if (toolCalls !== undefined && toolCalls.length > 0) {
      result.tool_calls = toolCalls;
    }
    return result;
  });
}

/** Rebuild an OpenAI tool-result message from its documented continuation fields. */
function transformToolResultMessage(
  message: JsonObject,
  param: string,
  ignored: Set<string>,
): JsonObject {
  if (message.tool_calls !== undefined) ignored.add(`${param}.tool_calls`);
  const toolCallId = message.tool_call_id;
  if (typeof toolCallId !== "string" || !toolCallId.trim()) {
    throw invalidRequest(
      `'${param}.tool_call_id' is required for tool messages.`,
      `${param}.tool_call_id`,
    );
  }
  if (typeof message.content !== "string") {
    throw invalidRequest(
      `'${param}.content' must be a string for tool messages.`,
      `${param}.content`,
    );
  }
  return {
    role: "tool",
    tool_call_id: toolCallId,
    content: message.content,
  };
}

/**
 * Keep only the documented OpenAI function-tool call fields so unrelated
 * upstream or client extensions never reach Agnes or leak into a request.
 * An empty array is treated as "no tool calls".
 */
function transformToolCalls(
  value: unknown,
  param: string,
  ignored: Set<string>,
): JsonObject[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw invalidRequest(`'${param}' must be an array.`, param);
  }
  if (value.length === 0) return undefined;
  return value.map((call, index) => {
    const callParam = `${param}.${index}`;
    if (!isJsonObject(call)) {
      throw invalidRequest(`'${callParam}' must be an object.`, callParam);
    }
    for (const field of collectUnknownFields(call, TOOL_CALL_FIELDS)) {
      ignored.add(`${callParam}.${field}`);
    }
    if (typeof call.id !== "string" || !call.id.trim()) {
      throw invalidRequest(
        `'${callParam}.id' must be a non-empty string.`,
        `${callParam}.id`,
      );
    }
    if (typeof call.type !== "string" || !call.type.trim()) {
      throw invalidRequest(
        `'${callParam}.type' must be a non-empty string.`,
        `${callParam}.type`,
      );
    }
    const fn = call.function;
    if (!isJsonObject(fn)) {
      throw invalidRequest(
        `'${callParam}.function' must be an object.`,
        `${callParam}.function`,
      );
    }
    for (const field of collectUnknownFields(fn, TOOL_FUNCTION_FIELDS)) {
      ignored.add(`${callParam}.function.${field}`);
    }
    if (typeof fn.name !== "string" || !fn.name.trim()) {
      throw invalidRequest(
        `'${callParam}.function.name' must be a non-empty string.`,
        `${callParam}.function.name`,
      );
    }
    if (typeof fn.arguments !== "string") {
      throw invalidRequest(
        `'${callParam}.function.arguments' must be a JSON string.`,
        `${callParam}.function.arguments`,
      );
    }
    return {
      id: call.id,
      type: call.type,
      function: { name: fn.name, arguments: fn.arguments },
    };
  });
}

function transformContentParts(
  parts: unknown[],
  param: string,
  ignored: Set<string>,
): JsonObject[] {
  if (parts.length === 0) {
    throw invalidRequest(`'${param}' must not be empty.`, param);
  }

  const transformed: JsonObject[] = [];
  for (const [index, part] of parts.entries()) {
    const partParam = `${param}.${index}`;
    if (!isJsonObject(part) || typeof part.type !== "string") {
      throw invalidRequest(
        `'${partParam}' must be a typed content block.`,
        partParam,
      );
    }

    if (part.type === "text") {
      if (typeof part.text !== "string") {
        throw invalidRequest(
          `'${partParam}.text' must be a string.`,
          `${partParam}.text`,
        );
      }
      transformed.push({ type: "text", text: part.text });
      for (const key of Object.keys(part)) {
        if (key !== "type" && key !== "text") {
          ignored.add(`${partParam}.${key}`);
        }
      }
      continue;
    }

    if (part.type === "image_url") {
      let url: string | undefined;
      if (typeof part.image_url === "string") {
        url = part.image_url;
      } else if (isJsonObject(part.image_url)) {
        if (typeof part.image_url.url === "string") url = part.image_url.url;
        for (const key of Object.keys(part.image_url)) {
          if (key !== "url") ignored.add(`${partParam}.image_url.${key}`);
        }
      }
      if (!url?.trim()) {
        throw invalidRequest(
          `'${partParam}.image_url' must contain a URL.`,
          `${partParam}.image_url`,
        );
      }
      transformed.push({ type: "image_url", image_url: { url } });
      for (const key of Object.keys(part)) {
        if (key !== "type" && key !== "image_url") {
          ignored.add(`${partParam}.${key}`);
        }
      }
      continue;
    }

    // Agnes documents text and image_url only. A mixed message can continue
    // after dropping audio/file parts; an entirely unsupported message cannot.
    ignored.add(partParam);
  }

  if (transformed.length === 0) {
    throw invalidRequest(
      `'${param}' contains no Agnes-compatible text or image content.`,
      param,
    );
  }
  return transformed;
}
