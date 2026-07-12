import {
  invalidParameter,
  invalidUpstreamResponse,
  isRecord,
  missingParameter,
  openAIError,
} from "./errors.ts";
import { parseHttpUrlWithoutUserinfo } from "./upstream.ts";

export type BuildResult<T> = { value: T } | { error: Response };

export const STANDARD_REQUEST_BODY_LIMIT_BYTES = 1024 * 1024;
export const IMAGE_EDIT_REQUEST_BODY_LIMIT_BYTES = 20 * 1024 * 1024;
const DEFAULT_IMAGE_GENERATION_SIZE = "2048x2048";

export interface VideoRequestInput {
  model?: unknown;
  prompt?: unknown;
  seconds?: unknown;
  size?: unknown;
  input_reference?: unknown;
}

export interface BuiltVideoRequest {
  body: Record<string, unknown>;
  prompt: string;
}

export interface BuiltImageGenerationRequest {
  body: Record<string, unknown>;
  count: number;
  outputField: "url" | "b64_json";
}

export interface SingleImageGenerationResult {
  created: number;
  image: Record<string, unknown>;
}

function requestBodyTooLarge(maxBytes: number): Response {
  return openAIError(
    413,
    `Request body exceeds the ${maxBytes}-byte limit.`,
    { code: "request_too_large" },
  );
}

async function readRequestBody(
  request: Request,
  maxBytes: number,
): Promise<BuildResult<Uint8Array>> {
  const contentLength = request.headers.get("content-length");
  if (
    contentLength !== null && /^\d+$/.test(contentLength.trim()) &&
    Number(contentLength) > maxBytes
  ) {
    if (request.body !== null) {
      await request.body.cancel().catch(() => undefined);
    }
    return { error: requestBodyTooLarge(maxBytes) };
  }

  if (request.body === null) return { value: new Uint8Array() };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      if (totalBytes + result.value.byteLength > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { error: requestBodyTooLarge(maxBytes) };
      }
      chunks.push(result.value);
      totalBytes += result.value.byteLength;
    }
  } catch {
    return {
      error: openAIError(400, "Unable to read request body.", {
        code: "invalid_request_body",
      }),
    };
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { value: body };
}

export async function parseJsonBody(
  request: Request,
  maxBytes = STANDARD_REQUEST_BODY_LIMIT_BYTES,
): Promise<BuildResult<Record<string, unknown>>> {
  const contentType = request.headers.get("content-type") ?? "";
  const mediaType = contentType.split(";", 1)[0].trim().toLowerCase();
  if (mediaType !== "application/json" && !mediaType.endsWith("+json")) {
    return {
      error: openAIError(415, "Content-Type must be application/json.", {
        code: "unsupported_media_type",
      }),
    };
  }

  const body = await readRequestBody(request, maxBytes);
  if ("error" in body) return body;

  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(body.value));
  } catch {
    return {
      error: openAIError(400, "Invalid JSON body.", {
        code: "invalid_json",
      }),
    };
  }

  if (!isRecord(value)) {
    return { error: invalidParameter("body", "a JSON object") };
  }

  return { value };
}

function requiredString(
  body: Record<string, unknown>,
  key: string,
): BuildResult<string> {
  if (!(key in body)) return { error: missingParameter(key) };
  const value = body[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    return { error: invalidParameter(key, "a non-empty string") };
  }
  return { value };
}

function imageGenerationSize(
  body: Record<string, unknown>,
): BuildResult<string> {
  if (!("size" in body) || body.size === null || body.size === "auto") {
    return { value: DEFAULT_IMAGE_GENERATION_SIZE };
  }
  return requiredString(body, "size");
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function buildChatRequest(
  input: Record<string, unknown>,
): BuildResult<Record<string, unknown>> {
  const model = requiredString(input, "model");
  if ("error" in model) return model;

  if (!("messages" in input)) return { error: missingParameter("messages") };
  if (!Array.isArray(input.messages) || input.messages.length === 0) {
    return { error: invalidParameter("messages", "a non-empty array") };
  }

  const body: Record<string, unknown> = {
    model: model.value,
    messages: input.messages,
  };

  for (const key of ["temperature", "top_p"] as const) {
    if (finiteNumber(input[key])) body[key] = input[key];
  }

  if (finiteNumber(input.max_tokens)) {
    body.max_tokens = input.max_tokens;
  } else if (finiteNumber(input.max_completion_tokens)) {
    body.max_tokens = input.max_completion_tokens;
  }

  if (typeof input.stream === "boolean") body.stream = input.stream;
  if (Array.isArray(input.tools)) body.tools = input.tools;
  if (typeof input.tool_choice === "string" || isRecord(input.tool_choice)) {
    body.tool_choice = input.tool_choice;
  }
  if (isRecord(input.chat_template_kwargs)) {
    body.chat_template_kwargs = input.chat_template_kwargs;
  }

  return { value: body };
}

export function buildImageGenerationRequest(
  input: Record<string, unknown>,
): BuildResult<BuiltImageGenerationRequest> {
  const model = requiredString(input, "model");
  if ("error" in model) return model;
  const prompt = requiredString(input, "prompt");
  if ("error" in prompt) return prompt;
  const size = imageGenerationSize(input);
  if ("error" in size) return size;

  const body: Record<string, unknown> = {
    model: model.value,
    prompt: prompt.value,
    size: size.value,
  };

  let count = 1;
  if (input.n !== undefined && input.n !== null) {
    if (
      typeof input.n !== "number" || !Number.isInteger(input.n) ||
      input.n < 1 || input.n > 10
    ) {
      return { error: invalidParameter("n", "an integer between 1 and 10") };
    }
    count = input.n;
  }

  const outputField = input.response_format === "b64_json" ? "b64_json" : "url";
  if (outputField === "b64_json") {
    body.return_base64 = true;
    body.extra_body = { response_format: "b64_json" };
  } else {
    body.extra_body = { response_format: "url" };
  }

  return { value: { body, count, outputField } };
}

export function transformSingleImageGenerationResponse(
  input: Record<string, unknown>,
  outputField: "url" | "b64_json",
): BuildResult<SingleImageGenerationResult> {
  if (
    !finiteNumber(input.created) || !Number.isSafeInteger(input.created) ||
    input.created < 0
  ) {
    return {
      error: invalidUpstreamResponse(
        "Agnes image response is missing a valid 'created'.",
      ),
    };
  }
  const image = Array.isArray(input.data) && input.data.length === 1 &&
      isRecord(input.data[0])
    ? input.data[0]
    : undefined;
  if (
    image === undefined ||
    typeof image[outputField] !== "string" || image[outputField].length === 0
  ) {
    return {
      error: invalidUpstreamResponse(
        "Agnes single-image response must contain exactly one image result.",
      ),
    };
  }

  return {
    value: {
      created: input.created,
      image,
    },
  };
}

function normalizeImages(value: unknown): BuildResult<string[]> {
  const validImageReference = (item: unknown): item is string => {
    if (typeof item !== "string" || item.length === 0) return false;
    if (parseHttpUrlWithoutUserinfo(item) !== undefined) return true;
    return /^data:image\/[a-z\d][a-z\d.+-]*(?:;[^,]*)?,.+$/is.test(item);
  };
  const expected =
    "an HTTP(S) URL without userinfo, an image Data URI, or a non-empty array of those values";

  if (validImageReference(value)) {
    return { value: [value] };
  }

  if (
    Array.isArray(value) && value.length > 0 &&
    value.every(validImageReference)
  ) {
    return { value: value as string[] };
  }

  return { error: invalidParameter("image", expected) };
}

export function buildImageEditRequest(
  input: Record<string, unknown>,
): BuildResult<Record<string, unknown>> {
  const model = requiredString(input, "model");
  if ("error" in model) return model;
  const prompt = requiredString(input, "prompt");
  if ("error" in prompt) return prompt;
  const size = requiredString(input, "size");
  if ("error" in size) return size;
  if (!("image" in input)) return { error: missingParameter("image") };
  const images = normalizeImages(input.image);
  if ("error" in images) return images;

  return {
    value: {
      model: model.value,
      prompt: prompt.value,
      size: size.value,
      extra_body: {
        image: images.value,
        response_format: input.response_format === "b64_json"
          ? "b64_json"
          : "url",
      },
    },
  };
}

function formString(form: FormData, key: string): string | undefined {
  const value = form.get(key);
  return typeof value === "string" ? value : undefined;
}

function parseReferenceString(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return { image_url: value };
  }
}

export async function parseVideoBody(
  request: Request,
): Promise<BuildResult<VideoRequestInput>> {
  const contentType = request.headers.get("content-type") ?? "";
  const mediaType = contentType.split(";", 1)[0].trim().toLowerCase();

  if (mediaType === "application/json" || mediaType.endsWith("+json")) {
    const parsed = await parseJsonBody(request);
    if ("error" in parsed) return parsed;
    return { value: parsed.value };
  }

  if (mediaType !== "multipart/form-data") {
    return {
      error: openAIError(
        415,
        "Content-Type must be application/json or multipart/form-data.",
        { code: "unsupported_media_type" },
      ),
    };
  }

  let form: FormData;
  const body = await readRequestBody(
    request,
    STANDARD_REQUEST_BODY_LIMIT_BYTES,
  );
  if ("error" in body) return body;
  try {
    form = await new Request(request.url, {
      method: "POST",
      headers: { "content-type": contentType },
      body: body.value.buffer as ArrayBuffer,
    }).formData();
  } catch {
    return {
      error: openAIError(400, "Invalid multipart form body.", {
        code: "invalid_multipart_body",
      }),
    };
  }

  const bracketReference = formString(form, "input_reference[image_url]");
  const directReference = formString(form, "input_reference");
  const inputReference = bracketReference !== undefined
    ? { image_url: bracketReference }
    : directReference !== undefined
    ? parseReferenceString(directReference)
    : undefined;

  return {
    value: {
      model: formString(form, "model"),
      prompt: formString(form, "prompt"),
      seconds: formString(form, "seconds"),
      size: formString(form, "size"),
      input_reference: inputReference,
    },
  };
}

function publicImageUrl(value: unknown): string | undefined {
  let candidate: unknown;
  if (isRecord(value)) candidate = value.image_url;
  else if (typeof value === "string") candidate = value;
  if (typeof candidate !== "string") return undefined;

  return parseHttpUrlWithoutUserinfo(candidate) === undefined
    ? undefined
    : candidate;
}

export function buildVideoRequest(
  input: VideoRequestInput,
): BuildResult<BuiltVideoRequest> {
  const record = input as Record<string, unknown>;
  const model = requiredString(record, "model");
  if ("error" in model) return model;
  const prompt = requiredString(record, "prompt");
  if ("error" in prompt) return prompt;

  const body: Record<string, unknown> = {
    model: model.value,
    prompt: prompt.value,
  };

  const seconds = typeof input.seconds === "string" ||
      typeof input.seconds === "number"
    ? Number(input.seconds)
    : Number.NaN;
  if (seconds === 4 || seconds === 8 || seconds === 12) {
    body.frame_rate = 24;
    body.num_frames = seconds * 24 + 1;
  }

  if (typeof input.size === "string") {
    const match = /^([1-9]\d*)x([1-9]\d*)$/.exec(input.size);
    if (match !== null) {
      const width = Number(match[1]);
      const height = Number(match[2]);
      if (Number.isSafeInteger(width) && Number.isSafeInteger(height)) {
        body.width = width;
        body.height = height;
      }
    }
  }

  const image = publicImageUrl(input.input_reference);
  if (image !== undefined) body.image = image;

  return { value: { body, prompt: prompt.value } };
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function normalizedVideoError(value: unknown): unknown {
  if (value === null) return null;
  if (typeof value === "string") {
    return { code: "video_failed", message: value };
  }
  if (!isRecord(value)) return undefined;

  const code = nonEmptyString(value.code) ? value.code : "video_failed";
  const message = nonEmptyString(value.message)
    ? value.message
    : "Video generation failed.";
  return { code, message };
}

function copyVideoFields(
  output: Record<string, unknown>,
  input: Record<string, unknown>,
): void {
  if (finiteNumber(input.progress)) output.progress = input.progress;
  if (nonEmptyString(input.size)) output.size = input.size;
  if (nonEmptyString(input.seconds)) output.seconds = input.seconds;
  else if (finiteNumber(input.seconds)) output.seconds = String(input.seconds);

  for (const key of ["created_at", "completed_at", "expires_at"] as const) {
    if (finiteNumber(input[key]) || input[key] === null) {
      output[key] = input[key];
    }
  }

  if (
    nonEmptyString(input.remixed_from_video_id) ||
    input.remixed_from_video_id === null
  ) {
    output.remixed_from_video_id = input.remixed_from_video_id;
  }

  if (nonEmptyString(input.prompt) || input.prompt === null) {
    output.prompt = input.prompt;
  }

  if ("error" in input) {
    const error = normalizedVideoError(input.error);
    if (error !== undefined) output.error = error;
  }
}

function requiredUpstreamString(
  input: Record<string, unknown>,
  key: string,
): string | Response {
  return nonEmptyString(input[key])
    ? input[key]
    : invalidUpstreamResponse(`Agnes video response is missing '${key}'.`);
}

export function transformCreatedVideo(
  input: Record<string, unknown>,
  prompt: string,
): BuildResult<Record<string, unknown>> {
  const id = requiredUpstreamString(input, "video_id");
  if (id instanceof Response) return { error: id };
  const model = requiredUpstreamString(input, "model");
  if (model instanceof Response) return { error: model };
  const status = requiredUpstreamString(input, "status");
  if (status instanceof Response) return { error: status };

  const output: Record<string, unknown> = {
    id,
    object: "video",
    model,
    status,
    prompt,
  };
  copyVideoFields(output, input);
  output.prompt = prompt;
  return { value: output };
}

export function transformRetrievedVideo(
  input: Record<string, unknown>,
  requestedId: string,
): BuildResult<Record<string, unknown>> {
  const model = requiredUpstreamString(input, "model");
  if (model instanceof Response) return { error: model };
  const status = requiredUpstreamString(input, "status");
  if (status instanceof Response) return { error: status };

  const output: Record<string, unknown> = {
    id: nonEmptyString(input.video_id) ? input.video_id : requestedId,
    object: "video",
    model,
    status,
  };
  copyVideoFields(output, input);
  return { value: output };
}

export function videoFailureMessage(input: Record<string, unknown>): string {
  if (isRecord(input.error) && nonEmptyString(input.error.message)) {
    return input.error.message;
  }
  if (nonEmptyString(input.error)) return input.error;
  return "Video generation failed.";
}
