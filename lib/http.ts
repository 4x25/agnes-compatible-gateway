import { GatewayError } from "./errors.ts";
import type { JsonObject, ResponseContext } from "./types.ts";

export const IGNORED_PARAMS_HEADER = "X-Agnes-Gateway-Ignored-Params";
export const UPSTREAM_REQUEST_ID_HEADER = "X-Agnes-Request-Id";

const MAX_IGNORED_PARAM_NAMES = 32;
const MAX_IGNORED_PARAM_LENGTH = 128;

const exposedHeaders = [
  "X-Request-ID",
  UPSTREAM_REQUEST_ID_HEADER,
  IGNORED_PARAMS_HEADER,
  "Retry-After",
  "X-RateLimit-Limit",
  "X-RateLimit-Remaining",
  "X-RateLimit-Reset",
  "X-RateLimit-Limit-Requests",
  "X-RateLimit-Remaining-Requests",
  "X-RateLimit-Reset-Requests",
  "X-RateLimit-Limit-Tokens",
  "X-RateLimit-Remaining-Tokens",
  "X-RateLimit-Reset-Tokens",
  "Accept-Ranges",
  "Content-Disposition",
  "Content-Length",
  "Content-Range",
  "ETag",
].join(", ");

/** Public, credential-free CORS policy shared by all API responses. */
export function corsHeaders(): Headers {
  return new Headers({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "Accept, Authorization, Content-Type, Range, X-Request-ID",
    "Access-Control-Expose-Headers": exposedHeaders,
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  });
}

/** Return a CORS preflight response without requiring an Agnes API key. */
export function preflightResponse(): Response {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

/** Reuse a safe caller request ID, otherwise generate one locally. */
export function getRequestId(request: Request): string {
  const candidate = request.headers.get("x-request-id")?.trim();
  if (
    candidate && candidate.length <= 128 &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(candidate)
  ) {
    return candidate;
  }
  return crypto.randomUUID();
}

/** Hash a correlation ID before it enters logs in case a caller used a key. */
export async function requestIdLogLabel(
  value: string | null,
): Promise<string | undefined> {
  if (!value) return undefined;
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  const prefix = [...digest.subarray(0, 8)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `sha256:${prefix}`;
}

/** Require BYOK authentication and return the exact Bearer header upstream. */
export function requireBearerAuthorization(request: Request): string {
  const value = request.headers.get("authorization")?.trim();
  if (!value || !/^Bearer\s+\S(?:.*\S)?$/i.test(value)) {
    throw new GatewayError(
      401,
      "Missing or invalid Authorization header. Provide your Agnes API key as a Bearer token.",
      { type: "authentication_error", code: "invalid_api_key" },
    );
  }
  return value;
}

/** Parse a JSON request while enforcing the total request-size limit. */
export async function parseJsonRequest(
  request: Request,
  maxBytes: number,
): Promise<JsonObject> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/json")) {
    throw new GatewayError(
      415,
      "Content-Type must be application/json.",
      { param: "Content-Type", code: "unsupported_media_type" },
    );
  }

  const bytes = await readRequestBytes(request, maxBytes);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new GatewayError(400, "Request body is not valid JSON.", {
      code: "invalid_json",
    });
  }

  if (!isJsonObject(value)) {
    throw new GatewayError(400, "Request body must be a JSON object.", {
      code: "invalid_json",
    });
  }
  return value;
}

/**
 * Parse multipart data only after buffering it through the gateway limit.
 * `Request.formData()` alone may allocate an unbounded body when Content-Length
 * is absent; recreating the request from bounded bytes closes that gap.
 */
export async function parseMultipartRequest(
  request: Request,
  maxBytes: number,
): Promise<FormData> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("multipart/form-data")) {
    throw new GatewayError(415, "Content-Type must be multipart/form-data.", {
      param: "Content-Type",
      code: "unsupported_media_type",
    });
  }
  const bytes = await readRequestBytes(request, maxBytes);
  try {
    const bounded = new Request("http://gateway.invalid/", {
      method: "POST",
      headers: { "content-type": contentType },
      body: Uint8Array.from(bytes).buffer,
    });
    return await bounded.formData();
  } catch {
    throw new GatewayError(400, "Malformed multipart request body.", {
      code: "invalid_multipart_body",
    });
  }
}

/** Consume a request stream and stop as soon as its configured limit is hit. */
export async function readRequestBytes(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength) {
    const parsed = Number(declaredLength);
    if (Number.isFinite(parsed) && parsed > maxBytes) {
      throw payloadTooLarge(maxBytes);
    }
  }

  if (!request.body) return new Uint8Array();
  return await readStreamBytes(
    request.body,
    maxBytes,
    () => payloadTooLarge(maxBytes),
  );
}

/** Read any byte stream with a hard upper bound. */
export async function readStreamBytes(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  errorFactory: () => Error,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("size limit exceeded");
        throw errorFactory();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function payloadTooLarge(maxBytes: number): GatewayError {
  return new GatewayError(
    413,
    `Request body exceeds the ${maxBytes}-byte gateway limit.`,
    { code: "request_too_large" },
  );
}

/** Create the standard OpenAI error object and attach gateway metadata. */
export function errorResponse(
  error: unknown,
  context: ResponseContext,
): Response {
  const normalized = error instanceof GatewayError ? error : new GatewayError(
    502,
    "The gateway could not complete the Agnes upstream request.",
    { type: "api_error", code: "upstream_connection_error" },
  );

  const headers = responseHeaders(context, normalized.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(
    JSON.stringify({
      error: {
        message: normalized.message,
        type: normalized.type,
        param: normalized.param,
        code: normalized.code,
      },
    }),
    { status: normalized.status, headers },
  );
}

/** Build a JSON response with the gateway's request and compatibility headers. */
export function jsonResponse(
  value: unknown,
  status: number,
  context: ResponseContext,
  extraHeaders?: HeadersInit,
): Response {
  const headers = responseHeaders(context, extraHeaders);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(value), { status, headers });
}

/**
 * Proxy an upstream body without buffering it. Passing the upstream stream
 * directly preserves Web Streams backpressure and propagates consumer cancel
 * to the upstream body, while intentionally avoiding the inbound request's
 * signal (which older Deno Deploy runtimes may abort after headers are sent).
 */
export function streamingResponse(
  upstream: Response,
  context: ResponseContext,
  options: { media?: boolean } = {},
): Response {
  const headers = responseHeaders(
    context,
    safeUpstreamHeaders(upstream.headers),
  );
  const contentType = upstream.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);

  if (options.media) {
    for (
      const name of [
        "accept-ranges",
        "content-disposition",
        "content-length",
        "content-range",
        "etag",
        "last-modified",
      ]
    ) {
      const value = upstream.headers.get(name);
      if (value) headers.set(name, value);
    }
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

/** Gateway/CORS metadata plus a narrow allowlist of safe upstream headers. */
export function responseHeaders(
  context: ResponseContext,
  extraHeaders?: HeadersInit,
): Headers {
  const headers = corsHeaders();
  // API responses are derived from a caller-owned credential and may contain
  // private prompts, media, or URLs. Never let a CDN/shared proxy reuse them
  // across Authorization values, even if an upstream media origin advertises
  // `Cache-Control: public`.
  headers.set("x-request-id", context.requestId);
  for (const [name, value] of new Headers(extraHeaders)) {
    headers.set(name, value);
  }
  headers.set("cache-control", "private, no-store");
  headers.set("vary", "Origin, Authorization, Range");
  const rawIgnored = [...new Set(context.ignoredParams ?? [])].sort();
  const ignored = [
    ...new Set(
      rawIgnored.slice(0, MAX_IGNORED_PARAM_NAMES).map(safeIgnoredParamName),
    ),
  ];
  if (rawIgnored.length > MAX_IGNORED_PARAM_NAMES) {
    ignored.push("<truncated>");
  }
  if (ignored.length > 0) {
    headers.set(IGNORED_PARAMS_HEADER, ignored.join(","));
  }
  return headers;
}

/** Copy only rate-limit and correlation metadata from Agnes. */
export function safeUpstreamHeaders(upstream: Headers): Headers {
  const result = new Headers();
  for (
    const name of [
      "retry-after",
      "x-ratelimit-limit",
      "x-ratelimit-remaining",
      "x-ratelimit-reset",
      "x-ratelimit-limit-requests",
      "x-ratelimit-remaining-requests",
      "x-ratelimit-reset-requests",
      "x-ratelimit-limit-tokens",
      "x-ratelimit-remaining-tokens",
      "x-ratelimit-reset-tokens",
    ]
  ) {
    const value = upstream.get(name);
    if (value) result.set(name, value);
  }
  const upstreamRequestId = upstream.get("x-request-id") ??
    upstream.get("request-id");
  if (upstreamRequestId) {
    result.set(UPSTREAM_REQUEST_ID_HEADER, upstreamRequestId);
  }
  return result;
}

/** Prevent arbitrary JSON property names from becoming sensitive/huge headers. */
function safeIgnoredParamName(value: string): string {
  return value.length <= MAX_IGNORED_PARAM_LENGTH &&
      /^[A-Za-z_][A-Za-z0-9_.\[\]-]*$/.test(value)
    ? value
    : "<redacted>";
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
