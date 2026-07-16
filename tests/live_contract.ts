/**
 * Opt-in contract probes for the real Agnes API.
 *
 * This module deliberately does not match Deno's automatic `*_test.ts`
 * discovery pattern. It is reachable only through `deno task test:live`, and
 * refuses to evaluate until both documented safety gates are present. The
 * probes validate envelopes and value types without printing response values,
 * prompts, media URLs, Base64 data, or the caller's disposable API key.
 */

type JsonObject = Record<string, unknown>;

type ProbeScope =
  | "chat"
  | "chat-sse"
  | "chat-tools"
  | "errors"
  | "image"
  | "image-base64"
  | "image-edit"
  | "video";

interface LiveConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly scopes: ReadonlySet<ProbeScope>;
  readonly chatModel: string;
  readonly imageModel: string;
  readonly videoModel: string;
  readonly waitForVideo: boolean;
}

interface JsonResponse {
  readonly response: Response;
  readonly body: JsonObject;
}

interface RegisteredProbe {
  readonly scope: ProbeScope;
  readonly name: string;
  readonly run: () => Promise<void>;
}

const DEFAULT_BASE_URL = "https://apihub.agnes-ai.com/v1";
const REQUEST_TIMEOUT_MS = 360_000;
const VIDEO_POLL_TIMEOUT_MS = 600_000;
const VIDEO_POLL_INTERVAL_MS = 5_000;
const MAX_SSE_BYTES = 2 * 1024 * 1024;
const MAX_JSON_BYTES = 64 * 1024 * 1024;
const ALL_SCOPES: readonly ProbeScope[] = [
  "chat",
  "chat-sse",
  "chat-tools",
  "errors",
  "image",
  "image-base64",
  "image-edit",
  "video",
];
const registeredProbes: RegisteredProbe[] = [];

// A small, solid-color PNG is sufficient to determine whether Agnes accepts a
// Data URI for image-to-image and image-to-video requests. It contains no user
// data and keeps probe payloads small. Media probes remain separately opt-in.
const TEST_PNG_DATA_URI =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABAAQMAAACQp+Od" +
  "AAAAA1BMVEUzZv+f8kW/AAAAD0lEQVQoz2NgGAWjgHwAAAJAAAGMxat3AAAAAElFTkSuQmCC";

const config = readConfig();

registerProbe("chat", "Agnes Chat JSON envelope", probeChatJson);
registerProbe("chat-sse", "Agnes Chat SSE envelope", probeChatSse);
registerProbe(
  "chat-tools",
  "Agnes Chat tool-call and tool-result envelopes",
  probeChatTools,
);
registerProbe("errors", "Agnes safe 400 and 401 error envelopes", probeErrors);
registerProbe("image", "Agnes image URL envelope", probeImageUrl);
registerProbe(
  "image-base64",
  "Agnes image Base64 envelope",
  probeImageBase64,
);
registerProbe(
  "image-edit",
  "Agnes image-edit Data URI envelope",
  probeImageEdit,
);
registerProbe("video", "Agnes video create and retrieve envelopes", probeVideo);
await runRegisteredProbes();

/** Read and validate every setting before a network-capable test is declared. */
function readConfig(): LiveConfig {
  const enabled = readEnv("RUN_AGNES_LIVE_TESTS");
  if (enabled !== "1") {
    throw new Error(
      "Live Agnes tests are disabled. Set RUN_AGNES_LIVE_TESTS=1 and a " +
        "non-empty AGNES_API_KEY_ONLY_FOR_TEST to run this task.",
    );
  }
  // Read the disposable key only after the explicit live-test switch passes.
  // Production and ordinary test execution never reach this branch.
  const apiKey = readEnv("AGNES_API_KEY_ONLY_FOR_TEST");
  if (apiKey === undefined) {
    throw new Error(
      "Live Agnes tests are disabled. Set RUN_AGNES_LIVE_TESTS=1 and a " +
        "non-empty AGNES_API_KEY_ONLY_FOR_TEST to run this task.",
    );
  }

  return {
    baseUrl: normalizeBaseUrl(readEnv("AGNES_BASE_URL") ?? DEFAULT_BASE_URL),
    apiKey,
    scopes: parseScopes(readEnv("AGNES_LIVE_SCOPES") ?? "chat"),
    chatModel: readEnv("AGNES_LIVE_CHAT_MODEL") ?? "agnes-2.0-flash",
    imageModel: readEnv("AGNES_LIVE_IMAGE_MODEL") ??
      "agnes-image-2.1-flash",
    videoModel: readEnv("AGNES_LIVE_VIDEO_MODEL") ?? "agnes-video-v2.0",
    waitForVideo: readEnv("AGNES_LIVE_VIDEO_WAIT_FOR_COMPLETION") === "1",
  };
}

/** Read a trimmed variable without ever inspecting dotenv files. */
function readEnv(name: string): string | undefined {
  const value = Deno.env.get(name)?.trim();
  return value === "" ? undefined : value;
}

/**
 * Require HTTPS because this task places a real disposable key on the wire.
 * Runtime gateway configuration remains independent and is not changed here.
 */
function normalizeBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("AGNES_BASE_URL must be an absolute HTTPS URL.");
  }

  if (
    parsed.protocol !== "https:" || parsed.username !== "" ||
    parsed.password !== "" || parsed.search !== "" || parsed.hash !== "" ||
    value.includes("?") || value.includes("#")
  ) {
    throw new Error(
      "AGNES_BASE_URL must be an HTTPS URL without credentials, query, or fragment.",
    );
  }

  return parsed.href.replace(/\/+$/, "");
}

/** Parse a comma-separated scope list; `all` expands to every costly probe. */
function parseScopes(value: string): ReadonlySet<ProbeScope> {
  const requested = value.split(",").map((scope) => scope.trim()).filter(
    Boolean,
  );
  if (requested.length === 0) {
    throw new Error("AGNES_LIVE_SCOPES must contain at least one probe scope.");
  }

  if (requested.includes("all")) {
    if (requested.length !== 1) {
      throw new Error("Use AGNES_LIVE_SCOPES=all by itself.");
    }
    return new Set(ALL_SCOPES);
  }

  const scopes = new Set<ProbeScope>();
  for (const scope of requested) {
    if (!isProbeScope(scope)) {
      throw new Error(
        `Unknown AGNES_LIVE_SCOPES entry '${safeLabel(scope)}'. ` +
          `Allowed entries: ${ALL_SCOPES.join(", ")}, all.`,
      );
    }
    scopes.add(scope);
  }
  return scopes;
}

function isProbeScope(value: string): value is ProbeScope {
  return (ALL_SCOPES as readonly string[]).includes(value);
}

/** Prevent an unexpected environment value from becoming arbitrary log text. */
function safeLabel(value: string): string {
  return /^[a-z0-9-]{1,32}$/.test(value) ? value : "<redacted>";
}

function registerProbe(
  scope: ProbeScope,
  name: string,
  probe: () => Promise<void>,
): void {
  if (config.scopes.has(scope)) {
    registeredProbes.push({ scope, name, run: probe });
  }
}

/** Run probes sequentially so a failure cannot trigger later billable work. */
async function runRegisteredProbes(): Promise<void> {
  for (const probe of registeredProbes) {
    console.log(JSON.stringify({ probe: probe.scope, state: "started" }));
    await probe.run();
    console.log(JSON.stringify({
      probe: probe.scope,
      name: probe.name,
      state: "passed",
    }));
  }
}

async function probeChatJson(): Promise<void> {
  const result = await postJson("chat", "chat/completions", {
    model: config.chatModel,
    messages: [{ role: "user", content: "Reply with the single word OK." }],
    temperature: 0,
    max_tokens: 8,
    stream: false,
  });

  expectString(result.body.id, "Chat response must contain a non-empty id.");
  const choices = expectArray(
    result.body.choices,
    "Chat response must contain a choices array.",
  );
  expect(choices.length > 0, "Chat response choices must not be empty.");
  const first = expectObject(
    choices[0],
    "Chat response choices[0] must be an object.",
  );
  expectObject(first.message, "Chat response must contain choices[0].message.");
  if (result.body.usage !== undefined) {
    expectObject(
      result.body.usage,
      "Chat usage, when present, must be an object.",
    );
  }

  recordShape("chat", result.response, result.body);
}

async function probeChatSse(): Promise<void> {
  const response = await liveFetch("chat-sse", "chat/completions", {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({
      model: config.chatModel,
      messages: [{ role: "user", content: "Reply with the single word OK." }],
      temperature: 0,
      max_tokens: 8,
      stream: true,
    }),
  });
  await requireSuccess("chat-sse", response);

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  expect(
    contentType.includes("text/event-stream"),
    "Streaming Chat must return Content-Type text/event-stream.",
  );
  const text = await readUtf8Body("chat-sse", response, MAX_SSE_BYTES);

  let doneSeen = false;
  let firstChunk: JsonObject | undefined;
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event.split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();
    if (data === "") continue;
    if (data === "[DONE]") {
      doneSeen = true;
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      throw new Error("Streaming Chat returned a non-JSON SSE data event.");
    }
    firstChunk ??= expectObject(
      parsed,
      "Streaming Chat data events must contain JSON objects.",
    );
  }

  expect(
    firstChunk !== undefined,
    "Streaming Chat returned no JSON data events.",
  );
  expect(doneSeen, "Streaming Chat did not terminate with a [DONE] event.");
  recordShape("chat-sse", response, firstChunk);
}

async function probeChatTools(): Promise<void> {
  const tool = {
    type: "function",
    function: {
      name: "get_contract_probe_value",
      description: "Return a fixed value for an API contract probe.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  };
  const requested = await postJson("chat-tools-call", "chat/completions", {
    model: config.chatModel,
    messages: [{
      role: "user",
      content: "Call get_contract_probe_value exactly once.",
    }],
    tools: [tool],
    tool_choice: {
      type: "function",
      function: { name: "get_contract_probe_value" },
    },
    temperature: 0,
    max_tokens: 64,
  });

  const message = firstChatMessage(requested.body, "Tool-call response");
  const toolCalls = expectArray(
    message.tool_calls,
    "Tool-call response must contain message.tool_calls.",
  );
  expect(
    toolCalls.length > 0,
    "Tool-call response must contain one tool call.",
  );
  const toolCall = expectObject(
    toolCalls[0],
    "Tool-call response tool_calls[0] must be an object.",
  );
  const toolCallId = expectString(
    toolCall.id,
    "Tool-call response must contain a tool-call id.",
  );
  expect(
    expectString(toolCall.type, "Tool-call type must be present.") ===
      "function",
    "Tool-call type must be function.",
  );
  const calledFunction = expectObject(
    toolCall.function,
    "Tool-call response must contain a function object.",
  );
  const calledName = expectString(
    calledFunction.name,
    "Tool-call response must contain a function name.",
  );
  expect(
    calledName === "get_contract_probe_value",
    "Tool-call response selected an unexpected function.",
  );
  const calledArguments = expectString(
    calledFunction.arguments,
    "Tool-call response must contain serialized function arguments.",
  );
  try {
    expectObject(
      JSON.parse(calledArguments),
      "Tool-call arguments must encode a JSON object.",
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Tool-call ")) {
      throw error;
    }
    throw new Error("Tool-call arguments must encode a JSON object.");
  }
  recordShape("chat-tools-call", requested.response, requested.body);

  // Reuse only the validated OpenAI tool-call fields. The second request
  // verifies that Agnes accepts a standard `tool` result message without
  // copying unrelated upstream fields back into the request.
  const completed = await postJson("chat-tools-result", "chat/completions", {
    model: config.chatModel,
    messages: [
      {
        role: "user",
        content: "Call get_contract_probe_value exactly once.",
      },
      {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: toolCallId,
          type: "function",
          function: { name: calledName, arguments: calledArguments },
        }],
      },
      {
        role: "tool",
        tool_call_id: toolCallId,
        content: "contract-probe-value",
      },
    ],
    tools: [tool],
    tool_choice: "none",
    temperature: 0,
    max_tokens: 32,
  });
  firstChatMessage(completed.body, "Tool-result response");
  recordShape("chat-tools-result", completed.response, completed.body);
}

async function probeErrors(): Promise<void> {
  // The authenticated request is deliberately missing required fields but
  // carries no prompt, media, or user-provided body content.
  const badRequest = await liveFetch("error-400", "chat/completions", {
    method: "POST",
    headers: jsonHeaders(),
    body: "{}",
  });
  expect(
    badRequest.status === 400 || badRequest.status === 422,
    "Invalid Chat input must return HTTP 400 or 422.",
  );
  const badRequestBody = await parseJsonObject("error-400", badRequest);
  recordShape("error-400", badRequest, badRequestBody);

  // Never mutate or intentionally invalidate the disposable real key. A fixed
  // fake token probes the authorization envelope without exposing that key.
  const unauthorized = await liveFetch("error-401", "chat/completions", {
    method: "POST",
    headers: new Headers({
      Authorization: "Bearer agnes-live-contract-intentionally-invalid",
      "Content-Type": "application/json",
    }),
    body: "{}",
  });
  expect(
    unauthorized.status === 401 || unauthorized.status === 403,
    "Invalid authentication must return HTTP 401 or 403.",
  );
  const unauthorizedBody = await parseJsonObject("error-401", unauthorized);
  recordShape("error-401", unauthorized, unauthorizedBody);
}

async function probeImageUrl(): Promise<void> {
  const result = await postJson("image", "images/generations", {
    model: config.imageModel,
    prompt: "A simple blue circle centered on a plain white background.",
    size: "1K",
    ratio: "1:1",
    extra_body: { response_format: "url" },
  });
  const item = firstImage(result.body);
  expectUrl(item.url, "Image URL response must contain data[0].url.");
  recordShape("image", result.response, result.body);
}

async function probeImageBase64(): Promise<void> {
  const result = await postJson("image-base64", "images/generations", {
    model: config.imageModel,
    prompt: "A simple green square centered on a plain white background.",
    size: "1K",
    ratio: "1:1",
    return_base64: true,
  });
  const item = firstImage(result.body);
  expectString(
    item.b64_json,
    "Image Base64 response must contain data[0].b64_json.",
  );
  recordShape("image-base64", result.response, result.body);
}

async function probeImageEdit(): Promise<void> {
  const result = await postJson("image-edit", "images/generations", {
    model: config.imageModel,
    prompt: "Change the image to red while preserving its composition.",
    size: "1K",
    ratio: "1:1",
    extra_body: {
      image: [TEST_PNG_DATA_URI],
      response_format: "b64_json",
    },
  });
  const item = firstImage(result.body);
  expectString(
    item.b64_json,
    "Image-edit response must contain data[0].b64_json.",
  );
  recordShape("image-edit", result.response, result.body);
}

async function probeVideo(): Promise<void> {
  const created = await postJson("video-create", "videos", {
    model: config.videoModel,
    prompt: "A blue circle moves slowly across a plain white background.",
    image: TEST_PNG_DATA_URI,
    mode: "ti2vid",
    width: 720,
    height: 1280,
    num_frames: 9,
    frame_rate: 24,
  });
  const taskId = firstNonEmptyString(
    created.body.task_id,
    created.body.id,
  );
  expect(taskId !== undefined, "Video creation must return task_id or id.");
  expectString(created.body.status, "Video creation must return a status.");
  recordShape("video-create", created.response, created.body);

  const deadline = Date.now() + VIDEO_POLL_TIMEOUT_MS;
  let retrieved: JsonResponse;
  while (true) {
    retrieved = await retrieveVideo(taskId!);
    const status = expectString(
      retrieved.body.status,
      "Video retrieval must return a status.",
    ).toLowerCase();

    if (!config.waitForVideo || isTerminalVideoStatus(status)) break;
    expect(
      Date.now() < deadline,
      "Video did not reach a terminal state before the live-test deadline.",
    );
    await delay(VIDEO_POLL_INTERVAL_MS);
  }

  const finalStatus = expectString(
    retrieved.body.status,
    "Video retrieval must return a status.",
  ).toLowerCase();
  if (config.waitForVideo) {
    expect(
      finalStatus === "completed" || finalStatus === "succeeded",
      "Video reached a non-success terminal state.",
    );
    const mediaUrl = expectUrl(
      retrieved.body.url,
      "A completed video response must contain a valid url.",
    );
    await probeVideoRange(mediaUrl);
  }
  recordShape("video-retrieve", retrieved.response, retrieved.body);
}

function firstChatMessage(body: JsonObject, label: string): JsonObject {
  const choices = expectArray(
    body.choices,
    `${label} must contain a choices array.`,
  );
  expect(choices.length > 0, `${label} choices must not be empty.`);
  const first = expectObject(
    choices[0],
    `${label} choices[0] must be an object.`,
  );
  return expectObject(
    first.message,
    `${label} must contain choices[0].message.`,
  );
}

async function probeVideoRange(mediaUrl: URL): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    // This request intentionally has no Authorization header. Completed media
    // can live on a third-party CDN and must never receive the Agnes API key.
    response = await fetch(mediaUrl, {
      method: "GET",
      headers: new Headers({ Range: "bytes=0-0" }),
      redirect: "follow",
      signal: controller.signal,
    });
    expect(
      response.status === 206,
      "Video media must honor a byte Range request.",
    );
    const contentRange = response.headers.get("content-range")?.toLowerCase();
    expect(
      contentRange?.startsWith("bytes 0-0/") === true,
      "Video Range response must describe byte 0 in Content-Range.",
    );
    const contentType = response.headers.get("content-type")?.toLowerCase() ??
      "";
    expect(
      contentType.startsWith("video/") ||
        contentType.startsWith("application/octet-stream"),
      "Video Range response must use a media content type.",
    );
    expect(response.body !== null, "Video Range response must contain bytes.");
    const reader = response.body!.getReader();
    const chunk = await reader.read();
    await reader.cancel();
    expect(
      !chunk.done && chunk.value.byteLength > 0,
      "Video Range response must contain at least one byte.",
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Video ")) {
      throw error;
    }
    throw new Error("Video media Range request failed; details were omitted.");
  } finally {
    clearTimeout(timer);
  }

  console.log(JSON.stringify({
    probe: "video-content-range",
    status: response.status,
    has_content_range: response.headers.has("content-range"),
    has_content_type: response.headers.has("content-type"),
  }));
}

function firstImage(body: JsonObject): JsonObject {
  const data = expectArray(
    body.data,
    "Image response must contain a data array.",
  );
  expect(data.length > 0, "Image response data must not be empty.");
  return expectObject(data[0], "Image response data[0] must be an object.");
}

async function retrieveVideo(taskId: string): Promise<JsonResponse> {
  // Newly-created task IDs can take a moment to appear on the legacy stateless
  // retrieval route. Retry only these reads; generation requests are never
  // retried, so the script cannot accidentally create duplicate billable work.
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await liveFetch(
      "video-retrieve",
      `videos/${encodeURIComponent(taskId)}`,
      { method: "GET", headers: authorizationHeaders() },
    );
    if (response.status !== 404 || attempt === 2) {
      return await readJsonResponse("video-retrieve", response);
    }
    await response.body?.cancel();
    await delay(1_000);
  }
  throw new Error("Video retrieval failed without a response.");
}

function isTerminalVideoStatus(status: string): boolean {
  return ["completed", "succeeded", "failed", "cancelled", "canceled"].includes(
    status,
  );
}

async function postJson(
  probe: string,
  path: string,
  body: JsonObject,
): Promise<JsonResponse> {
  const response = await liveFetch(probe, path, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify(body),
  });
  return await readJsonResponse(probe, response);
}

/**
 * Make a single upstream request with redirects disabled. Disabling redirects
 * guarantees the Authorization header cannot be forwarded to another origin.
 */
async function liveFetch(
  probe: string,
  path: string,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(`${config.baseUrl}/${path.replace(/^\/+/, "")}`, {
      ...init,
      redirect: "error",
      signal: controller.signal,
    });
  } catch {
    throw new Error(
      `${probe} network request failed or timed out; details were omitted.`,
    );
  } finally {
    clearTimeout(timer);
  }
}

function jsonHeaders(): Headers {
  const headers = authorizationHeaders();
  headers.set("Content-Type", "application/json");
  return headers;
}

function authorizationHeaders(): Headers {
  return new Headers({ Authorization: `Bearer ${config.apiKey}` });
}

async function readJsonResponse(
  probe: string,
  response: Response,
): Promise<JsonResponse> {
  await requireSuccess(probe, response);
  return { response, body: await parseJsonObject(probe, response) };
}

/** Parse a JSON envelope without ever including its values in an error. */
async function parseJsonObject(
  probe: string,
  response: Response,
): Promise<JsonObject> {
  const text = await readUtf8Body(probe, response, MAX_JSON_BYTES);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${probe} returned an invalid JSON body; content omitted.`);
  }
  return expectObject(body, `${probe} response must be a JSON object.`);
}

/**
 * Read a bounded UTF-8 response without allowing body bytes into diagnostics.
 * The body has its own timeout because `fetch()` resolves as soon as response
 * headers arrive, before a streaming or large media response has completed.
 */
async function readUtf8Body(
  probe: string,
  response: Response,
  maximumBytes: number,
): Promise<string> {
  if (response.body === null) {
    throw new Error(`${probe} returned an empty body.`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let body = "";
  let receivedBytes = 0;
  let timedOut = false;
  let tooLarge = false;
  let unreadable = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void reader.cancel().catch(() => undefined);
  }, REQUEST_TIMEOUT_MS);

  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      receivedBytes += chunk.value.byteLength;
      if (receivedBytes > maximumBytes) {
        tooLarge = true;
        await reader.cancel();
        break;
      }
      body += decoder.decode(chunk.value, { stream: true });
    }
    body += decoder.decode();
  } catch {
    unreadable = true;
  } finally {
    clearTimeout(timer);
  }

  if (timedOut) {
    throw new Error(`${probe} response body timed out; content omitted.`);
  }
  if (tooLarge) {
    throw new Error(`${probe} response body exceeded the probe size limit.`);
  }
  if (unreadable) {
    throw new Error(`${probe} returned an unreadable UTF-8 body.`);
  }
  return body;
}

async function requireSuccess(
  probe: string,
  response: Response,
): Promise<void> {
  if (response.ok) return;
  await response.body?.cancel().catch(() => undefined);
  throw new Error(
    `${probe} returned HTTP ${response.status}; response content was omitted.`,
  );
}

function expect(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function expectObject(value: unknown, message: string): JsonObject {
  expect(
    typeof value === "object" && value !== null && !Array.isArray(value),
    message,
  );
  return value as JsonObject;
}

function expectArray(value: unknown, message: string): unknown[] {
  expect(Array.isArray(value), message);
  return value;
}

function expectString(value: unknown, message: string): string {
  expect(typeof value === "string" && value.trim() !== "", message);
  return value;
}

function expectUrl(value: unknown, message: string): URL {
  const url = expectString(value, message);
  try {
    const parsed = new URL(url);
    expect(
      parsed.protocol === "https:" || parsed.protocol === "http:",
      message,
    );
    return parsed;
  } catch {
    throw new Error(message);
  }
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  return values.find((value): value is string =>
    typeof value === "string" && value.trim() !== ""
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Emit only value types and bounded field names. Primitive values, URLs,
 * prompts, Base64 payloads, IDs, and credentials never enter the test output.
 */
function recordShape(
  probe: string,
  response: Response,
  body: JsonObject | undefined,
): void {
  console.log(JSON.stringify({
    probe,
    status: response.status,
    request_id: redactedRequestId(response.headers),
    shape: describeShape(body),
  }));
}

function redactedRequestId(headers: Headers): string | undefined {
  const value = [
    "x-agnes-request-id",
    "x-request-id",
    "request-id",
    "cf-ray",
  ].map((name) => headers.get(name)?.trim()).find(Boolean);
  if (value === undefined) return undefined;
  if (value.length < 9) return "<redacted>";
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function describeShape(value: unknown, depth = 0): unknown {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return {
      type: "array",
      length: value.length,
      item: value.length === 0 || depth >= 3
        ? undefined
        : describeShape(value[0], depth + 1),
    };
  }
  if (typeof value !== "object") return typeof value;
  if (depth >= 3) return "object";

  const shape: JsonObject = {};
  for (const key of Object.keys(value as JsonObject).slice(0, 32)) {
    const safeKey = /^[A-Za-z0-9_.-]{1,64}$/.test(key) ? key : "<redacted-key>";
    shape[safeKey] = describeShape((value as JsonObject)[key], depth + 1);
  }
  return shape;
}
