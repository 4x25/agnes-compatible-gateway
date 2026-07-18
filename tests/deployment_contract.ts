/**
 * Opt-in acceptance probes for an already deployed gateway.
 *
 * Unlike `live_contract.ts`, which calls Agnes directly, this script exercises
 * the public OpenAI-compatible routes through a real deployment. It is kept
 * outside Deno's automatic `*_test.ts` discovery and requires explicit safety
 * gates because image and video scopes create real upstream work.
 */

type JsonObject = Record<string, unknown>;

type ProbeScope = "health" | "chat-sse" | "image-upload" | "video";

interface DeploymentConfig {
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly scopes: ReadonlySet<ProbeScope>;
  readonly chatModel: string;
  readonly imageModel: string;
  readonly videoModel: string;
}

interface JsonResponse {
  readonly response: Response;
  readonly body: JsonObject;
}

const ALL_SCOPES: readonly ProbeScope[] = [
  "health",
  "chat-sse",
  "image-upload",
  "video",
];
const REQUEST_TIMEOUT_MS = 360_000;
const VIDEO_POLL_TIMEOUT_MS = 600_000;
const VIDEO_POLL_INTERVAL_MS = 5_000;
const MAX_SSE_BYTES = 2 * 1024 * 1024;
const MAX_JSON_BYTES = 64 * 1024 * 1024;
const PROBE_ORIGIN = "https://deployment-contract.invalid";
const TEST_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAEAAAABAAQMAAACQp+Od" +
  "AAAAA1BMVEUzZv+f8kW/AAAAD0lEQVQoz2NgGAWjgHwAAAJAAAGMxat3AAAAAElFTkSuQmCC";
const TEST_PNG_DATA_URI = `data:image/png;base64,${TEST_PNG_BASE64}`;

const config = readConfig();
await runSelectedProbes();

/** Validate every input before any network request can be made. */
function readConfig(): DeploymentConfig {
  if (readEnv("RUN_DEPLOYMENT_LIVE_TESTS") !== "1") {
    throw new Error(
      "Deployment probes are disabled. Set RUN_DEPLOYMENT_LIVE_TESTS=1 " +
        "and DEPLOYMENT_SMOKE_BASE_URL explicitly.",
    );
  }

  const rawBaseUrl = readEnv("DEPLOYMENT_SMOKE_BASE_URL");
  if (rawBaseUrl === undefined) {
    throw new Error("DEPLOYMENT_SMOKE_BASE_URL must be set explicitly.");
  }
  const scopes = parseScopes(readEnv("DEPLOYMENT_SMOKE_SCOPES") ?? "health");
  const needsCredential = [...scopes].some((scope) => scope !== "health");
  const apiKey = readEnv("AGNES_API_KEY_ONLY_FOR_TEST");
  if (needsCredential && apiKey === undefined) {
    throw new Error(
      "Credentialed deployment probes require a non-empty " +
        "AGNES_API_KEY_ONLY_FOR_TEST.",
    );
  }

  return {
    baseUrl: normalizeBaseUrl(rawBaseUrl),
    apiKey,
    scopes,
    chatModel: readEnv("AGNES_LIVE_CHAT_MODEL") ?? "agnes-2.0-flash",
    imageModel: readEnv("AGNES_LIVE_IMAGE_MODEL") ??
      "agnes-image-2.1-flash",
    videoModel: readEnv("AGNES_LIVE_VIDEO_MODEL") ?? "agnes-video-v2.0",
  };
}

function readEnv(name: string): string | undefined {
  const value = Deno.env.get(name)?.trim();
  return value === "" ? undefined : value;
}

/** Require HTTPS, permitting plain HTTP only for an explicit loopback URL. */
function normalizeBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("DEPLOYMENT_SMOKE_BASE_URL must be an absolute HTTPS URL.");
  }
  const loopbackHttp = parsed.protocol === "http:" &&
    ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname);
  if (
    (parsed.protocol !== "https:" && !loopbackHttp) || parsed.username !== "" ||
    parsed.password !== "" || parsed.search !== "" || parsed.hash !== "" ||
    value.includes("?") || value.includes("#")
  ) {
    throw new Error(
      "DEPLOYMENT_SMOKE_BASE_URL must be HTTPS (or loopback HTTP) without credentials, query, or fragment.",
    );
  }
  return parsed.href.replace(/\/+$/, "");
}

function parseScopes(value: string): ReadonlySet<ProbeScope> {
  const requested = value.split(",").map((scope) => scope.trim()).filter(
    Boolean,
  );
  if (requested.length === 0) {
    throw new Error("DEPLOYMENT_SMOKE_SCOPES must contain a probe scope.");
  }
  if (requested.includes("all")) {
    if (requested.length !== 1) {
      throw new Error("Use DEPLOYMENT_SMOKE_SCOPES=all by itself.");
    }
    return new Set(ALL_SCOPES);
  }

  const scopes = new Set<ProbeScope>();
  for (const scope of requested) {
    if (!(ALL_SCOPES as readonly string[]).includes(scope)) {
      throw new Error(
        `Unknown deployment scope '${safeLabel(scope)}'. Allowed entries: ` +
          `${ALL_SCOPES.join(", ")}, all.`,
      );
    }
    scopes.add(scope as ProbeScope);
  }
  return scopes;
}

function safeLabel(value: string): string {
  return /^[a-z0-9-]{1,32}$/.test(value) ? value : "<redacted>";
}

/** Run sequentially so a failure prevents all later billable generation. */
async function runSelectedProbes(): Promise<void> {
  const probes: ReadonlyArray<{
    scope: ProbeScope;
    name: string;
    run: () => Promise<void>;
  }> = [
    { scope: "health", name: "health and CORS preflight", run: probeHealth },
    { scope: "chat-sse", name: "Chat SSE streaming", run: probeChatSse },
    {
      scope: "image-upload",
      name: "multipart image editing",
      run: probeImageUpload,
    },
    {
      scope: "video",
      name: "video create, poll, and Range content",
      run: probeVideo,
    },
  ];

  for (const probe of probes) {
    if (!config.scopes.has(probe.scope)) continue;
    console.log(JSON.stringify({ probe: probe.scope, state: "started" }));
    await probe.run();
    console.log(JSON.stringify({
      probe: probe.scope,
      name: probe.name,
      state: "passed",
    }));
  }
}

async function probeHealth(): Promise<void> {
  const health = await deploymentFetch("health", "healthz", { method: "GET" });
  await requireSuccess("health", health);
  expect(
    health.headers.get("cache-control")?.toLowerCase().includes("no-store") ===
      true,
    "Health response must disable caching.",
  );
  const healthBody = await parseJsonObject("health", health);
  expect(healthBody.status === "ok", "Health response must report status ok.");
  recordShape("health", health, healthBody);

  const preflight = await deploymentFetch(
    "cors-preflight",
    "v1/chat/completions",
    {
      method: "OPTIONS",
      headers: {
        Origin: PROBE_ORIGIN,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization,content-type",
      },
    },
  );
  expect(preflight.status === 204, "CORS preflight must return HTTP 204.");
  assertCorsHeaders(preflight);
  expectString(
    preflight.headers.get("x-request-id"),
    "CORS preflight must include X-Request-ID.",
  );
  await preflight.body?.cancel();
  recordShape("cors-preflight", preflight, undefined);
}

async function probeChatSse(): Promise<void> {
  const response = await deploymentFetch("chat-sse", "v1/chat/completions", {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({
      model: config.chatModel,
      messages: [{ role: "user", content: "Reply with the single word OK." }],
      temperature: 0,
      max_completion_tokens: 8,
      stream: true,
    }),
  });
  await requireSuccess("chat-sse", response);
  assertGatewayHeaders(response);
  expect(
    response.headers.get("content-type")?.toLowerCase().includes(
      "text/event-stream",
    ) === true,
    "Streaming Chat must return Content-Type text/event-stream.",
  );

  const text = await readUtf8Body("chat-sse", response, MAX_SSE_BYTES);
  let firstChunk: JsonObject | undefined;
  let doneSeen = false;
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
    try {
      firstChunk ??= expectObject(
        JSON.parse(data),
        "Chat SSE data events must be JSON objects.",
      );
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Chat SSE")) {
        throw error;
      }
      throw new Error("Chat SSE returned a non-JSON data event.");
    }
  }
  expect(firstChunk !== undefined, "Chat SSE returned no JSON data event.");
  expect(doneSeen, "Chat SSE did not terminate with [DONE].");
  recordShape("chat-sse", response, firstChunk);
}

async function probeImageUpload(): Promise<void> {
  const form = new FormData();
  form.set("model", config.imageModel);
  form.set(
    "prompt",
    "Change the image to red while preserving its composition.",
  );
  form.set("size", "1024x1024");
  form.set("response_format", "b64_json");
  form.set(
    "image",
    new File([decodeBase64(TEST_PNG_BASE64)], "deployment-probe.png", {
      type: "image/png",
    }),
  );

  const response = await deploymentFetch("image-upload", "v1/images/edits", {
    method: "POST",
    headers: authorizationHeaders(),
    body: form,
  });
  const result = await readJsonResponse("image-upload", response);
  assertGatewayHeaders(result.response);
  const data = expectArray(
    result.body.data,
    "Image-edit response must contain a data array.",
  );
  expect(data.length > 0, "Image-edit response data must not be empty.");
  const item = expectObject(data[0], "Image-edit data[0] must be an object.");
  expectString(
    item.b64_json,
    "Image-edit data[0] must contain a Base64 result.",
  );
  recordShape("image-upload", result.response, result.body);
}

async function probeVideo(): Promise<void> {
  const created = await postJson("video-create", "v1/videos", {
    model: config.videoModel,
    prompt: "A blue circle moves slowly across a plain white background.",
    input_reference: TEST_PNG_DATA_URI,
    seconds: "4",
    size: "720x1280",
  });
  assertGatewayHeaders(created.response);
  const videoId = expectString(
    created.body.id,
    "Video creation must return a public id.",
  );
  expectString(created.body.status, "Video creation must return a status.");
  recordShape("video-create", created.response, created.body);

  const deadline = Date.now() + VIDEO_POLL_TIMEOUT_MS;
  let retrieved: JsonResponse | undefined;
  while (retrieved === undefined) {
    const response = await deploymentFetch(
      "video-retrieve",
      `v1/videos/${encodeURIComponent(videoId)}`,
      { method: "GET", headers: authorizationHeaders() },
    );
    if (response.status === 404) {
      await response.body?.cancel();
    } else {
      const candidate = await readJsonResponse("video-retrieve", response);
      assertGatewayHeaders(candidate.response);
      const status = expectString(
        candidate.body.status,
        "Video retrieval must return a status.",
      ).toLowerCase();
      if (isTerminalVideoStatus(status)) {
        retrieved = candidate;
        break;
      }
    }
    expect(
      Date.now() < deadline,
      "Video did not reach a terminal state before the deployment deadline.",
    );
    await delay(VIDEO_POLL_INTERVAL_MS);
  }

  const finalStatus = expectString(
    retrieved.body.status,
    "Video retrieval must return a terminal status.",
  ).toLowerCase();
  expect(
    finalStatus === "completed" || finalStatus === "succeeded",
    "Video reached a non-success terminal state.",
  );
  recordShape("video-retrieve", retrieved.response, retrieved.body);

  const content = await deploymentFetch(
    "video-content-range",
    `v1/videos/${encodeURIComponent(videoId)}/content`,
    {
      method: "GET",
      headers: new Headers({
        Authorization: `Bearer ${requireApiKey()}`,
        Origin: PROBE_ORIGIN,
        Range: "bytes=0-0",
      }),
    },
  );
  expect(
    content.status === 206,
    "Video content must honor Range with HTTP 206.",
  );
  assertGatewayHeaders(content);
  expect(
    content.headers.get("content-range")?.toLowerCase().startsWith(
      "bytes 0-0/",
    ) === true,
    "Video content must describe byte zero in Content-Range.",
  );
  expect(content.body !== null, "Video content must include a response body.");
  const reader = content.body!.getReader();
  const chunk = await reader.read();
  await reader.cancel();
  expect(
    !chunk.done && chunk.value.byteLength > 0,
    "Video content Range response must contain at least one byte.",
  );
  recordShape("video-content-range", content, undefined);
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
  const response = await deploymentFetch(probe, path, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify(body),
  });
  return await readJsonResponse(probe, response);
}

/**
 * Make one bounded, no-redirect request to the configured deployment.
 * Refusing redirects prevents a caller credential from leaving that origin.
 */
async function deploymentFetch(
  probe: string,
  path: string,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(
      new URL(path.replace(/^\/+/, ""), `${config.baseUrl}/`),
      { ...init, redirect: "error", signal: controller.signal },
    );
  } catch {
    throw new Error(
      `${probe} deployment request failed or timed out; details were omitted.`,
    );
  } finally {
    clearTimeout(timer);
  }
}

function authorizationHeaders(): Headers {
  return new Headers({
    Authorization: `Bearer ${requireApiKey()}`,
    Origin: PROBE_ORIGIN,
  });
}

function jsonHeaders(): Headers {
  const headers = authorizationHeaders();
  headers.set("Content-Type", "application/json");
  return headers;
}

function requireApiKey(): string {
  if (config.apiKey === undefined) {
    throw new Error("This deployment probe requires a disposable caller key.");
  }
  return config.apiKey;
}

async function readJsonResponse(
  probe: string,
  response: Response,
): Promise<JsonResponse> {
  await requireSuccess(probe, response);
  return { response, body: await parseJsonObject(probe, response) };
}

async function parseJsonObject(
  probe: string,
  response: Response,
): Promise<JsonObject> {
  const text = await readUtf8Body(probe, response, MAX_JSON_BYTES);
  try {
    return expectObject(
      JSON.parse(text),
      `${probe} response must be a JSON object.`,
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`${probe} `)) {
      throw error;
    }
    throw new Error(`${probe} returned invalid JSON; content was omitted.`);
  }
}

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
  let bytes = 0;
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
      bytes += chunk.value.byteLength;
      if (bytes > maximumBytes) {
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

  if (timedOut) throw new Error(`${probe} response body timed out.`);
  if (tooLarge) throw new Error(`${probe} response exceeded its size limit.`);
  if (unreadable) throw new Error(`${probe} returned unreadable UTF-8.`);
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

function assertGatewayHeaders(response: Response): void {
  assertCorsHeaders(response);
  const cacheControl = response.headers.get("cache-control")?.toLowerCase() ??
    "";
  expect(
    cacheControl.includes("no-store"),
    "Gateway response must disable shared or browser caching.",
  );
  expectString(
    response.headers.get("x-request-id"),
    "Gateway response must include X-Request-ID.",
  );
}

function assertCorsHeaders(response: Response): void {
  expect(
    response.headers.get("access-control-allow-origin") === "*",
    "Gateway response must expose wildcard non-credentialed CORS.",
  );
}

function decodeBase64(value: string): ArrayBuffer {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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

/** Log only bounded field/type metadata; never values or media. */
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
  const value = headers.get("x-request-id")?.trim();
  if (value === undefined || value === "") return undefined;
  if (value.length < 9) return "<redacted>";
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function describeShape(value: unknown, depth = 0): unknown {
  if (value === undefined) return undefined;
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
