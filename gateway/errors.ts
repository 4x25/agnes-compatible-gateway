export interface OpenAIErrorBody {
  error: {
    message: string;
    type: string;
    param: string | null;
    code: string | null;
  };
}

export interface OpenAIErrorOptions {
  type?: string;
  param?: string | null;
  code?: string | null;
  headers?: HeadersInit;
}

const SAFE_RESPONSE_HEADERS = new Set([
  "openai-request-id",
  "retry-after",
  "www-authenticate",
  "x-request-id",
]);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function safeResponseHeaders(source: Headers): Headers {
  const headers = new Headers();

  for (const [name, value] of source) {
    const lowerName = name.toLowerCase();
    if (
      SAFE_RESPONSE_HEADERS.has(lowerName) ||
      lowerName.startsWith("ratelimit-") ||
      lowerName.startsWith("x-ratelimit-")
    ) {
      headers.set(name, value);
    }
  }

  return headers;
}

export function jsonResponse(
  body: unknown,
  status = 200,
  sourceHeaders?: Headers,
): Response {
  const headers = sourceHeaders === undefined
    ? new Headers()
    : safeResponseHeaders(sourceHeaders);
  headers.set("content-type", "application/json; charset=utf-8");

  return new Response(JSON.stringify(body), { status, headers });
}

function defaultErrorType(status: number): string {
  if (status === 401 || status === 403) return "authentication_error";
  if (status === 429) return "rate_limit_error";
  if (status >= 500) return "api_error";
  return "invalid_request_error";
}

export function openAIError(
  status: number,
  message: string,
  options: OpenAIErrorOptions = {},
): Response {
  const body: OpenAIErrorBody = {
    error: {
      message,
      type: options.type ?? defaultErrorType(status),
      param: options.param ?? null,
      code: options.code ?? null,
    },
  };

  const headers = new Headers(options.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { status, headers });
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return readString(value);
}

function safePlainText(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.startsWith("<")) return undefined;
  return trimmed.slice(0, 4096);
}

export async function normalizeUpstreamError(
  response: Response,
): Promise<Response> {
  const text = await response.text();
  let parsed: unknown;

  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
  }

  let message: string | undefined;
  let type: string | undefined;
  let param: string | null | undefined;
  let code: string | null | undefined;

  if (isRecord(parsed)) {
    const nested = parsed.error;
    if (isRecord(nested)) {
      message = readString(nested.message);
      type = readString(nested.type);
      param = readNullableString(nested.param);
      code = readNullableString(nested.code);
    } else if (typeof nested === "string") {
      message = readString(nested);
    }

    message ??= readString(parsed.message);
    type ??= readString(parsed.type);
    param ??= readNullableString(parsed.param);
    code ??= readNullableString(parsed.code);
  }

  message ??= safePlainText(text);
  message ??= `Agnes API request failed with status ${response.status}.`;

  return openAIError(response.status, message, {
    type,
    param,
    code,
    headers: safeResponseHeaders(response.headers),
  });
}

export function missingParameter(param: string): Response {
  return openAIError(400, `Missing required parameter: '${param}'.`, {
    param,
    code: "missing_required_parameter",
  });
}

export function invalidParameter(param: string, expected: string): Response {
  return openAIError(400, `Invalid '${param}': expected ${expected}.`, {
    param,
    code: "invalid_parameter",
  });
}

export function invalidUpstreamResponse(message: string): Response {
  return openAIError(502, message, {
    type: "api_error",
    code: "invalid_upstream_response",
  });
}
