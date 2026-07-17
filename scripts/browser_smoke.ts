/**
 * Browser smoke test for the bilingual landing page.
 *
 * The test deliberately talks to Chromium through its built-in DevTools
 * Protocol instead of adding a browser-automation dependency. By default it
 * builds the app, starts its production server on a free loopback port, and
 * tears down both child processes on exit. Set BROWSER_SMOKE_BASE_URL to
 * exercise an already running deployment instead.
 */

const CHROMIUM_PATH_CANDIDATES = [
  // Chromium supplied by this project's current development environment.
  "/root/.cloakbrowser/chromium-146.0.7680.177.5/chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/opt/google/chrome/chrome",
  "/snap/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
] as const;
const CHROMIUM_COMMAND_CANDIDATES = [
  "chromium",
  "chromium-browser",
  "google-chrome",
  "google-chrome-stable",
  "chrome",
] as const;
// A cold production build can take several minutes on constrained CI or network
// filesystems. Individual phases use this deadline independently.
const DEFAULT_TIMEOUT_MS = 600_000;
const VIEWPORTS = [320, 360, 430, 600, 1024, 1280] as const;
const VIEWPORT_HEIGHT = 900;
const TEST_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const TEST_VIDEO_BYTES = new Uint8Array([
  0x00,
  0x00,
  0x00,
  0x18,
  0x66,
  0x74,
  0x79,
  0x70,
  0x69,
  0x73,
  0x6f,
  0x6d,
  0x00,
  0x00,
  0x02,
  0x00,
  0x69,
  0x73,
  0x6f,
  0x6d,
  0x69,
  0x73,
  0x6f,
  0x32,
  0x00,
  0x00,
  0x00,
  0x08,
  0x6d,
  0x64,
  0x61,
  0x74,
]);

interface ChildHandle {
  child: Deno.ChildProcess;
  status: Promise<Deno.CommandStatus>;
}

interface CdpMessage {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: {
    code: number;
    message: string;
  };
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

type CdpEventListener = (params: unknown) => void;

interface EventWaiter {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: number;
}

interface TargetDescription {
  id: string;
  webSocketDebuggerUrl: string;
}

interface EvaluationResponse {
  result: {
    value?: unknown;
    description?: string;
  };
  exceptionDetails?: {
    text?: string;
    exception?: { description?: string };
  };
}

interface OverflowResult {
  width: number;
  rootClientWidth: number;
  rootScrollWidth: number;
  bodyClientWidth: number;
  bodyScrollWidth: number;
  brandTextVisible: boolean;
  brandMarkVisible: boolean;
  githubVisible: boolean;
  themeVisible: boolean;
  localeVisible: boolean;
  menuVisible: boolean;
  headerItemsDoNotOverlap: boolean;
}

interface CredentialScan {
  inputContainsSentinel: boolean;
  localStorageContainsSentinel: boolean;
  sessionStorageContainsSentinel: boolean;
  cookieContainsSentinel: boolean;
  serializedDomContainsSentinel: boolean;
  textContainsSentinel: boolean;
  attributeContainsSentinel: boolean;
  otherFieldContainsSentinel: boolean;
}

interface AccessibilitySemantics {
  allButtonsHaveExplicitValidType: boolean;
  allButtonsHaveAccessibleName: boolean;
  keyInputHasLabel: boolean;
  localeButtonIsValid: boolean;
  workflowTabsAreValid: boolean;
  submitButtonIsValid: boolean;
}

interface FocusSnapshot {
  marker: "locale" | "key" | "workflow" | "other";
  interactive: boolean;
  focusVisible: boolean;
}

interface MotionSample {
  reduced: boolean;
  scrollBehavior: string;
  transitionSeconds: number;
  animationSeconds: number;
  animationIterationCount: string;
}

interface FakeAgnesRequest {
  method: string;
  path: string;
  authorization: string | null;
  contentType: string | null;
  body?: Record<string, unknown>;
}

interface FakeAgnesServer {
  baseUrl: string;
  requests: FakeAgnesRequest[];
  close: () => Promise<void>;
}

interface BrowserNetworkRequest {
  method: string;
  pathname: string;
}

function fail(message: string): never {
  throw new Error(`Browser smoke failed: ${message}`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) fail(message);
}

function parsePositiveInteger(value: string | undefined, fallback: number) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    fail(`expected a positive integer, received ${JSON.stringify(value)}`);
  }
  return parsed;
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function joinFilesystemPath(directory: string, name: string) {
  const separator = Deno.build.os === "windows" ? "\\" : "/";
  return directory.endsWith("/") || directory.endsWith("\\")
    ? `${directory}${name}`
    : `${directory}${separator}${name}`;
}

async function isFile(path: string) {
  try {
    return (await Deno.stat(path)).isFile;
  } catch {
    return false;
  }
}

async function findCommand(name: string) {
  const path = Deno.env.get("PATH") ?? "";
  const delimiter = Deno.build.os === "windows" ? ";" : ":";
  const suffixes = Deno.build.os === "windows" ? ["", ".exe"] : [""];
  for (const directory of path.split(delimiter).filter(Boolean)) {
    for (const suffix of suffixes) {
      const candidate = joinFilesystemPath(directory, `${name}${suffix}`);
      if (await isFile(candidate)) return candidate;
    }
  }
  return undefined;
}

/** Resolve an override first, then common installation paths and PATH names. */
async function resolveChromiumPath() {
  const configured = Deno.env.get("CHROMIUM_PATH")?.trim();
  if (configured) {
    if (await isFile(configured)) return configured;
    const command = await findCommand(configured);
    if (command) return command;
    fail(`CHROMIUM_PATH does not identify an executable file: ${configured}`);
  }

  const dynamicCandidates: string[] = [];
  const localAppData = Deno.env.get("LOCALAPPDATA");
  if (localAppData) {
    dynamicCandidates.push(
      joinFilesystemPath(
        localAppData,
        "Google\\Chrome\\Application\\chrome.exe",
      ),
      joinFilesystemPath(
        localAppData,
        "Chromium\\Application\\chrome.exe",
      ),
    );
  }
  for (const variable of ["PROGRAMFILES", "PROGRAMFILES(X86)"]) {
    const directory = Deno.env.get(variable);
    if (directory) {
      dynamicCandidates.push(
        joinFilesystemPath(
          directory,
          "Google\\Chrome\\Application\\chrome.exe",
        ),
      );
    }
  }

  for (
    const candidate of [
      ...CHROMIUM_PATH_CANDIDATES,
      ...dynamicCandidates,
    ]
  ) {
    if (await isFile(candidate)) return candidate;
  }
  for (const name of CHROMIUM_COMMAND_CANDIDATES) {
    const command = await findCommand(name);
    if (command) return command;
  }
  fail(
    "no Chromium-compatible browser was found; set CHROMIUM_PATH explicitly",
  );
}

async function withTimeout<T>(
  promise: Promise<T>,
  milliseconds: number,
  message: string,
): Promise<T> {
  let timer = 0;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), milliseconds);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function freeLoopbackPort(): number {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  try {
    return (listener.addr as Deno.NetAddr).port;
  } finally {
    listener.close();
  }
}

function startChild(
  command: string,
  args: string[],
  options: {
    stdout?: "inherit" | "null";
    stderr?: "inherit" | "null";
    env?: Record<string, string>;
  } = {},
): ChildHandle {
  const child = new Deno.Command(command, {
    args,
    stdin: "null",
    stdout: options.stdout ?? "null",
    stderr: options.stderr ?? "null",
    env: options.env,
  }).spawn();
  return { child, status: child.status };
}

async function stopChild(handle: ChildHandle | undefined) {
  if (!handle) return;
  try {
    handle.child.kill("SIGTERM");
  } catch {
    // The child may already have exited; its status below is still awaited.
  }

  try {
    await withTimeout(handle.status, 4_000, "process did not stop");
  } catch {
    try {
      handle.child.kill("SIGKILL");
    } catch {
      // Ignore a race with a process that exited after the timeout.
    }
    await handle.status.catch(() => undefined);
  }
}

async function waitForHttp(url: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let lastFailure = "no response";
  while (Date.now() < deadline) {
    try {
      // Give a cold deployment enough time to produce its first response while
      // still bounding every individual readiness probe.
      const requestTimeout = Math.min(
        20_000,
        Math.max(1, deadline - Date.now()),
      );
      const response = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(requestTimeout),
      });
      if (response.ok) return;
      lastFailure = `HTTP ${response.status}`;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }
    await delay(200);
  }
  fail(`timed out waiting for ${url} (${lastFailure})`);
}

function chatText(body: Record<string, unknown> | undefined) {
  const messages = body?.messages;
  if (!Array.isArray(messages)) return "";
  return messages.map((message) => {
    if (!message || typeof message !== "object") return "";
    const content = (message as Record<string, unknown>).content;
    return typeof content === "string" ? content : "";
  }).join(" ");
}

function fakeSseResponse(cancelProbe: boolean) {
  const encoder = new TextEncoder();
  let timer = 0;
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(
        cancelProbe
          ? 'data: {"choices":[{"delta":{"content":"cancel stream started"}}]}\n\n'
          : 'data: {"choices":[{"delta":{"content":"browser "}}]}\n\n',
      ));
      if (!cancelProbe) {
        controller.enqueue(encoder.encode(
          'data: {"choices":[{"delta":{"content":"smoke chat"}}]}\n\n' +
            "data: [DONE]\n\n",
        ));
        closed = true;
        controller.close();
        return;
      }
      // The UI cancels this deliberately. The fallback close prevents a failed
      // assertion from leaving an open fake SSE connection during cleanup.
      timer = setTimeout(() => {
        if (closed) return;
        closed = true;
        controller.close();
      }, 5_000);
    },
    cancel() {
      closed = true;
      clearTimeout(timer);
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      "x-request-id": "fake-chat-request",
    },
  });
}

/**
 * Start a loopback-only Agnes double. Browser requests still cross the real
 * gateway; only the gateway's upstream origin is replaced for deterministic,
 * credential-safe workflow coverage.
 */
async function startFakeAgnes(timeoutMs: number): Promise<FakeAgnesServer> {
  const port = freeLoopbackPort();
  const origin = `http://127.0.0.1:${port}`;
  const requests: FakeAgnesRequest[] = [];
  let videoCounter = 0;
  const abort = new AbortController();
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port,
    signal: abort.signal,
    onListen() {},
  }, async (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") return new Response("ok");

    let body: Record<string, unknown> | undefined;
    if (request.method === "POST") {
      try {
        const value = await request.json();
        if (value && typeof value === "object" && !Array.isArray(value)) {
          body = value as Record<string, unknown>;
        }
      } catch {
        return Response.json({ error: "invalid fake request" }, {
          status: 400,
        });
      }
    }
    requests.push({
      method: request.method,
      path: url.pathname,
      authorization: request.headers.get("authorization"),
      contentType: request.headers.get("content-type"),
      body,
    });

    if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
      return fakeSseResponse(chatText(body).includes("cancel-smoke"));
    }
    if (
      request.method === "POST" &&
      url.pathname === "/v1/images/generations"
    ) {
      return Response.json({
        created: 1,
        data: [{ b64_json: TEST_PNG_BASE64 }],
      }, { headers: { "x-request-id": "fake-image-request" } });
    }
    if (request.method === "POST" && url.pathname === "/v1/videos") {
      videoCounter += 1;
      return Response.json({
        task_id: `browser-video-${videoCounter}`,
        status: "queued",
        progress: 0,
      }, {
        status: 201,
        headers: { "x-request-id": "fake-video-create" },
      });
    }
    const videoMatch = /^\/v1\/videos\/([^/]+)$/.exec(url.pathname);
    if (request.method === "GET" && videoMatch) {
      const taskId = decodeURIComponent(videoMatch[1]);
      return Response.json({
        task_id: taskId,
        status: "completed",
        progress: 100,
        url: `${origin}/media/${encodeURIComponent(taskId)}.mp4`,
      }, { headers: { "x-request-id": "fake-video-retrieve" } });
    }
    if (request.method === "GET" && url.pathname.startsWith("/media/")) {
      return new Response(TEST_VIDEO_BYTES.slice().buffer, {
        headers: {
          "content-type": "video/mp4",
          "content-length": String(TEST_VIDEO_BYTES.byteLength),
          "accept-ranges": "bytes",
        },
      });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  });

  await waitForHttp(`${origin}/healthz`, timeoutMs);
  return {
    baseUrl: `${origin}/v1`,
    requests,
    close: async () => {
      abort.abort();
      await server.finished.catch(() => undefined);
    },
  };
}

/** Minimal request/response and event layer for a single CDP page target. */
class CdpClient {
  #socket: WebSocket;
  #nextId = 1;
  #pending = new Map<number, PendingCall>();
  #waiters = new Map<string, EventWaiter[]>();
  #listeners = new Map<string, Set<CdpEventListener>>();
  #closed = false;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.addEventListener("message", (event) => this.#onMessage(event));
    socket.addEventListener("close", () => this.#onClose());
  }

  static async connect(url: string, timeoutMs: number) {
    const socket = new WebSocket(url);
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve(), { once: true });
        socket.addEventListener(
          "error",
          () => reject(new Error("Chromium DevTools WebSocket failed to open")),
          { once: true },
        );
      }),
      timeoutMs,
      "timed out connecting to Chromium DevTools WebSocket",
    );
    return new CdpClient(socket);
  }

  #onMessage(event: MessageEvent) {
    let message: CdpMessage;
    try {
      message = JSON.parse(String(event.data)) as CdpMessage;
    } catch {
      return;
    }

    if (message.id !== undefined) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) {
        pending.reject(
          new Error(
            `CDP ${message.error.code}: ${message.error.message}`,
          ),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (!message.method) return;
    for (const listener of this.#listeners.get(message.method) ?? []) {
      listener(message.params);
    }
    const waiters = this.#waiters.get(message.method);
    if (!waiters?.length) return;
    this.#waiters.delete(message.method);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(message.params);
    }
  }

  #onClose() {
    if (this.#closed) return;
    this.#closed = true;
    const error = new Error("Chromium DevTools WebSocket closed unexpectedly");
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    for (const waiters of this.#waiters.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
    }
    this.#waiters.clear();
  }

  call(method: string, params: Record<string, unknown> = {}) {
    if (this.#closed) {
      return Promise.reject(new Error("cannot call a closed CDP connection"));
    }
    const id = this.#nextId++;
    return new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#socket.send(JSON.stringify({ id, method, params }));
    });
  }

  waitForEvent(method: string, timeoutMs: number) {
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        const remaining = (this.#waiters.get(method) ?? []).filter((waiter) =>
          waiter.timer !== timer
        );
        if (remaining.length) this.#waiters.set(method, remaining);
        else this.#waiters.delete(method);
        reject(new Error(`timed out waiting for CDP event ${method}`));
      }, timeoutMs);
      const waiter: EventWaiter = { resolve, reject, timer };
      const existing = this.#waiters.get(method) ?? [];
      existing.push(waiter);
      this.#waiters.set(method, existing);
    });
  }

  on(method: string, listener: CdpEventListener) {
    const listeners = this.#listeners.get(method) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(method, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.#listeners.delete(method);
    };
  }

  async evaluate<T>(expression: string): Promise<T> {
    const response = await this.call("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    }) as EvaluationResponse;
    if (response.exceptionDetails) {
      const description = response.exceptionDetails.exception?.description ??
        response.exceptionDetails.text ?? "unknown page exception";
      throw new Error(`page evaluation failed: ${description}`);
    }
    return response.result.value as T;
  }

  close() {
    this.#closed = true;
    this.#socket.close();
    const error = new Error("CDP connection closed");
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    for (const waiters of this.#waiters.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
    }
    this.#waiters.clear();
    this.#listeners.clear();
  }
}

async function waitForPageCondition(
  client: CdpClient,
  expression: string,
  timeoutMs: number,
  description: string,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await client.evaluate<boolean>(expression)) return;
    await delay(50);
  }
  fail(`timed out waiting for ${description}`);
}

async function startLocalServer(timeoutMs: number, agnesBaseUrl: string) {
  const configuredPort = Deno.env.get("BROWSER_SMOKE_PORT");
  const port = configuredPort
    ? parsePositiveInteger(configuredPort, 0)
    : freeLoopbackPort();
  assert(port <= 65_535, "BROWSER_SMOKE_PORT must be at most 65535");
  const baseUrl = `http://127.0.0.1:${port}`;
  if (Deno.env.get("BROWSER_SMOKE_SKIP_BUILD") !== "1") {
    console.log("Building the Fresh application for browser smoke testing");
    const build = startChild(Deno.execPath(), ["task", "build"], {
      stdout: "inherit",
      stderr: "inherit",
    });
    try {
      const status = await withTimeout(
        build.status,
        timeoutMs,
        "timed out building the Fresh application",
      );
      assert(status.success, `Fresh build exited with code ${status.code}`);
    } catch (error) {
      await stopChild(build);
      throw error;
    }
  }

  try {
    const stat = await Deno.stat("_fresh/server.js");
    assert(stat.isFile, "the Fresh production server build is missing");
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      fail(
        "_fresh/server.js is missing; remove BROWSER_SMOKE_SKIP_BUILD or run deno task build",
      );
    }
    throw error;
  }

  console.log(`Starting the local Fresh production server at ${baseUrl}`);
  const server = startChild(Deno.execPath(), [
    "serve",
    "--allow-env",
    "--allow-net",
    "--allow-read",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "_fresh/server.js",
  ], {
    stdout: "inherit",
    stderr: "inherit",
    env: { AGNES_BASE_URL: agnesBaseUrl },
  });

  try {
    await waitForHttp(`${baseUrl}/healthz`, timeoutMs);
    return { baseUrl, server };
  } catch (error) {
    await stopChild(server);
    throw error;
  }
}

async function startChromium(path: string, timeoutMs: number) {
  try {
    const stat = await Deno.stat(path);
    assert(stat.isFile, `Chromium path is not a file: ${path}`);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      fail(
        `Chromium was not found at ${path}; set CHROMIUM_PATH to its binary`,
      );
    }
    throw error;
  }

  const debuggingPort = freeLoopbackPort();
  const profile = await Deno.makeTempDir({ prefix: "agnes-browser-smoke-" });
  const browser = startChild(path, [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--disable-background-networking",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-sync",
    "--metrics-recording-only",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${debuggingPort}`,
    `--user-data-dir=${profile}`,
    "about:blank",
  ]);

  const devtoolsUrl = `http://127.0.0.1:${debuggingPort}`;
  try {
    await waitForHttp(`${devtoolsUrl}/json/version`, timeoutMs);
    return { browser, devtoolsUrl, profile };
  } catch (error) {
    await stopChild(browser);
    await Deno.remove(profile, { recursive: true }).catch(() => undefined);
    throw error;
  }
}

async function createPageClient(devtoolsUrl: string, timeoutMs: number) {
  const response = await fetch(
    `${devtoolsUrl}/json/new?${encodeURIComponent("about:blank")}`,
    { method: "PUT" },
  );
  assert(
    response.ok,
    `could not create a Chromium page (HTTP ${response.status})`,
  );
  const target = await response.json() as TargetDescription;
  assert(
    target.id && target.webSocketDebuggerUrl,
    "Chromium did not return a debuggable page target",
  );
  return {
    client: await CdpClient.connect(target.webSocketDebuggerUrl, timeoutMs),
    targetId: target.id,
  };
}

async function testLanguages(client: CdpClient, timeoutMs: number) {
  const current = await client.evaluate<string>(
    `document.documentElement.lang`,
  );
  if (current !== "en") {
    await client.evaluate(`document.querySelector(".locale-button")?.click()`);
    await waitForPageCondition(
      client,
      `document.documentElement.lang === "en"`,
      timeoutMs,
      "the English locale",
    );
  }

  const english = await client.evaluate<{ title: string; button: string }>(`({
    title: document.querySelector("#hero-title")?.textContent ?? "",
    button: document.querySelector(".locale-button")?.textContent?.trim() ?? ""
  })`);
  assert(
    english.title.includes("One OpenAI shape."),
    "English hero copy was not rendered",
  );
  assert(english.button === "中文", "English locale switch label is incorrect");

  await client.evaluate(`document.querySelector(".locale-button")?.click()`);
  await waitForPageCondition(
    client,
    `document.documentElement.lang === "zh-Hans"`,
    timeoutMs,
    "the Simplified Chinese locale",
  );
  const chinese = await client.evaluate<{ title: string; button: string }>(`({
    title: document.querySelector("#hero-title")?.textContent ?? "",
    button: document.querySelector(".locale-button")?.textContent?.trim() ?? ""
  })`);
  assert(
    chinese.title.includes("一种 OpenAI 格式"),
    "Simplified Chinese hero copy was not rendered",
  );
  assert(chinese.button === "EN", "Chinese locale switch label is incorrect");

  // Return to English so subsequent assertions have a stable accessible label.
  await client.evaluate(`document.querySelector(".locale-button")?.click()`);
  await waitForPageCondition(
    client,
    `document.documentElement.lang === "en"`,
    timeoutMs,
    "the restored English locale",
  );
  console.log("✓ English and Simplified Chinese switching");
}

async function testSimplifiedPage(
  client: CdpClient,
  gatewayOrigin: string,
) {
  const snapshot = await client.evaluate<{
    playgroundIntro: string;
    compatibilityIntro: string;
    connectionSettingsRemoved: boolean;
    requestHintRemoved: boolean;
    matrixControlsRemoved: boolean;
    credentialSectionRemoved: boolean;
    quickStartRemoved: boolean;
    compatibilityTableRows: number;
    compatibilityCardRows: number;
    placeholderRemoved: boolean;
  }>(`(() => ({
    playgroundIntro:
      document.querySelector("#playground-title")?.parentElement
        ?.parentElement?.querySelector(":scope > p")?.textContent?.trim() ?? "",
    compatibilityIntro:
      document.querySelector("#compatibility-title")?.parentElement
        ?.parentElement?.querySelector(":scope > p")?.textContent?.trim() ?? "",
    connectionSettingsRemoved:
      document.querySelector(".connection-settings") === null,
    requestHintRemoved: document.querySelector(".panel-actions > span") === null,
    matrixControlsRemoved: document.querySelector(".matrix-controls") === null,
    credentialSectionRemoved:
      document.querySelector(".security-section") === null,
    quickStartRemoved: document.querySelector("#quickstart") === null &&
      document.querySelector('a[href="#quickstart"]') === null &&
      document.querySelector('button[onclick*="quickstart"]') === null,
    compatibilityTableRows:
      document.querySelectorAll(".compatibility-table tbody tr").length,
    compatibilityCardRows:
      document.querySelectorAll(".compatibility-cards > article").length,
    placeholderRemoved:
      !document.documentElement.innerHTML.includes("your-gateway.example")
  }))()`);

  assert(
    snapshot.playgroundIntro ===
      "Your Agnes key stays only in this page's memory.",
    "the live-test introduction was not shortened",
  );
  assert(
    snapshot.compatibilityIntro ===
      "The gateway transforms only the mismatches it can resolve safely.",
    "the compatibility introduction was not shortened",
  );
  assert(
    snapshot.connectionSettingsRemoved && snapshot.requestHintRemoved &&
      snapshot.matrixControlsRemoved && snapshot.credentialSectionRemoved &&
      snapshot.quickStartRemoved,
    "a removed landing-page control or section is still rendered",
  );
  assert(
    snapshot.compatibilityTableRows === 6 &&
      snapshot.compatibilityCardRows === 6,
    "the unfiltered compatibility matrix does not contain all six routes",
  );
  assert(snapshot.placeholderRemoved, "the placeholder gateway host remains");

  const curlExamples = await client.evaluate<string[]>(`(async () => {
    const workbench = document.querySelector(
      '[data-od-id="hero-code-workbench"]'
    );
    const curl = Array.from(workbench?.querySelectorAll(".code-mode button") ?? [])
      .find((button) => button.textContent?.trim() === "cURL");
    if (!(curl instanceof HTMLButtonElement)) return [];
    curl.click();
    const tabs = Array.from(
      workbench?.querySelectorAll(".endpoint-tabs-dark [role=tab]") ?? []
    );
    const result = [];
    for (const tab of tabs) {
      if (!(tab instanceof HTMLButtonElement)) continue;
      tab.click();
      await new Promise((resolve) => requestAnimationFrame(() =>
        requestAnimationFrame(resolve)
      ));
      result.push(workbench?.querySelector(".code-body pre")?.textContent ?? "");
    }
    return result;
  })()`);
  const expectedPaths = [
    "/v1/chat/completions",
    "/v1/images/generations",
    "/v1/images/edits",
    "/v1/videos",
    "/v1/videos",
  ];
  assert(
    curlExamples.length === expectedPaths.length,
    "hero cURL tabs missing",
  );
  expectedPaths.forEach((path, index) => {
    assert(
      curlExamples[index].includes(`${gatewayOrigin}${path}`),
      `hero cURL example ${index} does not use the current origin`,
    );
  });

  const sdkExample = await client.evaluate<string>(`(async () => {
    const workbench = document.querySelector(
      '[data-od-id="hero-code-workbench"]'
    );
    const firstTab = workbench?.querySelector(
      ".endpoint-tabs-dark [role=tab]"
    );
    const sdk = Array.from(workbench?.querySelectorAll(".code-mode button") ?? [])
      .find((button) => button.textContent?.trim() === "OpenAI SDK");
    if (!(firstTab instanceof HTMLButtonElement) ||
      !(sdk instanceof HTMLButtonElement)) return "";
    firstTab.click();
    sdk.click();
    await new Promise((resolve) => requestAnimationFrame(() =>
      requestAnimationFrame(resolve)
    ));
    return workbench?.querySelector(".code-body pre")?.textContent ?? "";
  })()`);
  assert(
    sdkExample.includes(`baseURL: "${gatewayOrigin}/v1"`),
    "hero SDK example does not use the current origin",
  );
  console.log("✓ Simplified sections and current-origin examples");
}

async function testViewports(client: CdpClient) {
  for (const width of VIEWPORTS) {
    await client.call("Emulation.setDeviceMetricsOverride", {
      width,
      height: VIEWPORT_HEIGHT,
      deviceScaleFactor: 1,
      mobile: width < 768,
      screenWidth: width,
      screenHeight: VIEWPORT_HEIGHT,
    });
    const result = await client.evaluate<OverflowResult>(`(async () => {
      await document.fonts.ready;
      await new Promise((resolve) => requestAnimationFrame(() =>
        requestAnimationFrame(resolve)
      ));
      const root = document.documentElement;
      const body = document.body;
      const visible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" &&
          rect.width > 0 && rect.height > 0;
      };
      const brand = document.querySelector(".site-header .brand");
      const brandText = document.querySelector(
        ".site-header .brand > span:not(.brand-mark)"
      );
      const brandMark = document.querySelector(".site-header .brand-mark");
      const actions = document.querySelector(".site-header .header-actions");
      const github = document.querySelector(".site-header .github-chip");
      const theme = document.querySelector(
        ".site-header .header-actions > .icon-button:not(.menu-button)"
      );
      const locale = document.querySelector(".site-header .locale-button");
      const menu = document.querySelector(".site-header .menu-button");
      const brandRect = brand?.getBoundingClientRect();
      const actionsRect = actions?.getBoundingClientRect();
      return {
        width: innerWidth,
        rootClientWidth: root.clientWidth,
        rootScrollWidth: root.scrollWidth,
        bodyClientWidth: body.clientWidth,
        bodyScrollWidth: body.scrollWidth,
        brandTextVisible: visible(brandText),
        brandMarkVisible: visible(brandMark),
        githubVisible: visible(github),
        themeVisible: visible(theme),
        localeVisible: visible(locale),
        menuVisible: visible(menu),
        headerItemsDoNotOverlap: Boolean(brandRect && actionsRect) &&
          brandRect.right <= actionsRect.left &&
          brandRect.left >= 0 && actionsRect.right <= innerWidth
      };
    })()`);
    assert(
      result.width === width,
      `Chromium did not apply the ${width}px viewport (got ${result.width}px)`,
    );
    const rootOverflow = result.rootScrollWidth - result.rootClientWidth;
    const bodyOverflow = result.bodyScrollWidth - result.bodyClientWidth;
    assert(
      rootOverflow <= 1 && bodyOverflow <= 1,
      `${width}px viewport overflows horizontally ` +
        `(root +${rootOverflow}px, body +${bodyOverflow}px)`,
    );
    if (width === 320 || width === 360) {
      assert(
        result.brandTextVisible && result.githubVisible &&
          result.themeVisible && result.localeVisible && result.menuVisible,
        `${width}px header visibility mismatch ` +
          `(brand=${result.brandTextVisible}, github=${result.githubVisible}, ` +
          `theme=${result.themeVisible}, locale=${result.localeVisible}, ` +
          `menu=${result.menuVisible})`,
      );
      assert(
        result.headerItemsDoNotOverlap,
        `${width}px header brand and actions overlap or leave the viewport`,
      );
      assert(
        result.brandMarkVisible === (width >= 360),
        `${width}px header has the wrong brand-mark visibility`,
      );
    }
    console.log(`✓ ${width}px viewport has no horizontal page overflow`);
  }
}

async function pressTab(client: CdpClient) {
  const event = {
    key: "Tab",
    code: "Tab",
    windowsVirtualKeyCode: 9,
    nativeVirtualKeyCode: 9,
  };
  await client.call("Input.dispatchKeyEvent", {
    ...event,
    type: "rawKeyDown",
  });
  await client.call("Input.dispatchKeyEvent", { ...event, type: "keyUp" });
  await delay(10);
}

async function testKeyboardAccessibility(client: CdpClient) {
  const semantics = await client.evaluate<AccessibilitySemantics>(`(() => {
    const buttons = Array.from(document.querySelectorAll("button"));
    const locale = document.querySelector(".locale-button");
    const keyInput = document.querySelector(".key-field input");
    const workflowTabs = Array.from(
      document.querySelectorAll(".endpoint-tabs-light [role=tab]")
    );
    const submit = document.querySelector(".request-panel button[type=submit]");
    const accessibleName = (element) =>
      (element.getAttribute("aria-label") ?? "").trim() ||
      (element.textContent ?? "").trim();
    return {
      allButtonsHaveExplicitValidType: buttons.every((button) =>
        button.hasAttribute("type") &&
        (button.type === "button" || button.type === "submit")
      ),
      allButtonsHaveAccessibleName: buttons.every((button) =>
        Boolean(accessibleName(button))
      ),
      keyInputHasLabel: keyInput instanceof HTMLInputElement &&
        keyInput.labels?.length === 1,
      localeButtonIsValid: locale instanceof HTMLButtonElement &&
        locale.type === "button" && Boolean(accessibleName(locale)),
      workflowTabsAreValid: workflowTabs.length === 5 &&
        workflowTabs.every((tab) => tab instanceof HTMLButtonElement &&
          tab.type === "button" && tab.getAttribute("role") === "tab" &&
          tab.hasAttribute("aria-selected") && Boolean(accessibleName(tab))),
      submitButtonIsValid: submit instanceof HTMLButtonElement &&
        submit.type === "submit" && Boolean(accessibleName(submit))
    };
  })()`);
  assert(
    semantics.allButtonsHaveExplicitValidType,
    "a button lacks an explicit valid type",
  );
  assert(
    semantics.allButtonsHaveAccessibleName,
    "a button lacks an accessible name",
  );
  assert(semantics.keyInputHasLabel, "the API key input is not labelled");
  assert(
    semantics.localeButtonIsValid,
    "the locale control does not use valid button semantics",
  );
  assert(
    semantics.workflowTabsAreValid,
    "the playground workflow controls do not use valid tab/button semantics",
  );
  assert(
    semantics.submitButtonIsValid,
    "the playground submit control does not use valid button semantics",
  );

  await client.evaluate(`(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    scrollTo(0, 0);
  })()`);
  const reached: FocusSnapshot["marker"][] = [];
  const visible = new Map<FocusSnapshot["marker"], boolean>();
  for (let index = 0; index < 80; index++) {
    await pressTab(client);
    const snapshot = await client.evaluate<FocusSnapshot>(`(() => {
      const element = document.activeElement;
      if (!(element instanceof HTMLElement)) {
        return { marker: "other", interactive: false, focusVisible: false };
      }
      const marker = element.matches(".locale-button")
        ? "locale"
        : element.matches(".key-field input")
        ? "key"
        : element.matches(".endpoint-tabs-light [role=tab]")
        ? "workflow"
        : "other";
      const tag = element.tagName.toLowerCase();
      const interactive =
        (tag === "a" && element.hasAttribute("href")) ||
        ["button", "input", "textarea", "select", "summary"].includes(tag) ||
        element.tabIndex >= 0;
      const style = getComputedStyle(element);
      const focusVisible =
        (style.outlineStyle !== "none" && parseFloat(style.outlineWidth) >= 1) ||
        (style.boxShadow !== "none" && style.boxShadow !== "");
      return { marker, interactive, focusVisible };
    })()`);
    assert(snapshot.interactive, "Tab focus landed on a non-interactive node");
    if (snapshot.marker !== "other" && !reached.includes(snapshot.marker)) {
      reached.push(snapshot.marker);
      visible.set(snapshot.marker, snapshot.focusVisible);
    }
    if (
      reached.includes("locale") && reached.includes("key") &&
      reached.includes("workflow")
    ) break;
  }

  assert(
    reached.join(",") === "locale,key,workflow",
    "Tab did not reach locale, API key, and playground controls in DOM order",
  );
  for (const marker of ["locale", "key", "workflow"] as const) {
    assert(
      visible.get(marker),
      `${marker} control has no visible keyboard focus`,
    );
  }
  console.log(
    "✓ Keyboard focus order, visibility, labels, and button semantics",
  );
}

async function motionSample(client: CdpClient) {
  return await client.evaluate<MotionSample>(`(() => {
    const seconds = (value) => Math.max(...value.split(",").map((part) => {
      const item = part.trim();
      return item.endsWith("ms") ? parseFloat(item) / 1000 : parseFloat(item);
    }));
    const button = document.querySelector(".button");
    const activity = document.createElement("span");
    activity.className = "activity-line";
    activity.style.cssText =
      "position:fixed;left:-100px;top:-100px;pointer-events:none";
    const dot = document.createElement("i");
    activity.append(dot);
    document.body.append(activity);
    const buttonStyle = getComputedStyle(button);
    const dotStyle = getComputedStyle(dot);
    const result = {
      reduced: matchMedia("(prefers-reduced-motion: reduce)").matches,
      scrollBehavior: getComputedStyle(document.documentElement).scrollBehavior,
      transitionSeconds: seconds(buttonStyle.transitionDuration),
      animationSeconds: seconds(dotStyle.animationDuration),
      animationIterationCount: dotStyle.animationIterationCount
    };
    activity.remove();
    return result;
  })()`);
}

async function testReducedMotion(client: CdpClient) {
  await client.call("Emulation.setEmulatedMedia", {
    media: "",
    features: [{ name: "prefers-reduced-motion", value: "no-preference" }],
  });
  const normal = await motionSample(client);
  assert(!normal.reduced, "normal motion media emulation was not applied");
  assert(
    normal.scrollBehavior === "smooth" && normal.transitionSeconds >= 0.1 &&
      normal.animationSeconds >= 0.8 &&
      normal.animationIterationCount === "infinite",
    "the baseline page does not expose the expected motion styles",
  );

  await client.call("Emulation.setEmulatedMedia", {
    media: "",
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  const reduced = await motionSample(client);
  assert(reduced.reduced, "reduced-motion media emulation was not applied");
  assert(
    reduced.scrollBehavior === "auto" &&
      reduced.transitionSeconds <= 0.001 &&
      reduced.animationSeconds <= 0.001 &&
      reduced.animationIterationCount === "1",
    "reduced-motion styles do not suppress smooth scrolling and repeated motion",
  );

  await client.call("Emulation.setEmulatedMedia", {
    media: "",
    features: [{ name: "prefers-reduced-motion", value: "no-preference" }],
  });
  console.log("✓ prefers-reduced-motion suppresses transitions and animation");
}

async function setFormValue(
  client: CdpClient,
  selector: string,
  value: string,
) {
  const updated = await client.evaluate<boolean>(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLInputElement) &&
      !(element instanceof HTMLTextAreaElement)) return false;
    element.value = ${JSON.stringify(value)};
    element.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: null
    }));
    return element.value === ${JSON.stringify(value)};
  })()`);
  assert(updated, `could not update playground field ${selector}`);
}

async function selectWorkflow(
  client: CdpClient,
  index: number,
  timeoutMs: number,
) {
  const clicked = await client.evaluate<boolean>(`(() => {
    const tabs = document.querySelectorAll(".endpoint-tabs-light [role=tab]");
    const tab = tabs[${index}];
    if (!(tab instanceof HTMLButtonElement)) return false;
    tab.click();
    return true;
  })()`);
  assert(clicked, `playground workflow tab ${index} is missing`);
  await waitForPageCondition(
    client,
    `document.querySelectorAll(".endpoint-tabs-light [role=tab]")[${index}]` +
      `?.getAttribute("aria-selected") === "true"`,
    timeoutMs,
    `playground workflow ${index}`,
  );
}

async function submitPlayground(client: CdpClient) {
  const submitted = await client.evaluate<boolean>(`(() => {
    const button = document.querySelector(
      ".request-panel button[type=submit]"
    );
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    return true;
  })()`);
  assert(submitted, "the playground submit button is unavailable");
}

async function setPlaygroundFile(client: CdpClient, path: string) {
  const remote = await client.call("Runtime.evaluate", {
    expression: `document.querySelector(".file-drop input[type=file]")`,
    returnByValue: false,
  }) as {
    result?: { objectId?: string };
    exceptionDetails?: unknown;
  };
  const objectId = remote.result?.objectId;
  assert(
    objectId && !remote.exceptionDetails,
    "the playground file input is unavailable",
  );
  await client.call("DOM.setFileInputFiles", {
    files: [path],
    objectId,
  });
}

async function assertRawRequestRedacted(
  client: CdpClient,
  key: string,
  expectedPath: string,
  timeoutMs: number,
) {
  const opened = await client.evaluate<boolean>(`(() => {
    const button = document.querySelector(".raw-inspector > button");
    if (!(button instanceof HTMLButtonElement)) return false;
    if (button.getAttribute("aria-expanded") !== "true") button.click();
    return true;
  })()`);
  assert(opened, "the raw request inspector is unavailable");
  await waitForPageCondition(
    client,
    `document.querySelector(".raw-sections pre") instanceof HTMLElement`,
    timeoutMs,
    "the sanitized raw request inspector",
  );
  const check = await client.evaluate<{
    containsPath: boolean;
    containsRedaction: boolean;
    containsKey: boolean;
  }>(`(() => {
    const text = document.querySelector(".raw-sections pre")?.textContent ?? "";
    const key = ${JSON.stringify(key)};
    return {
      containsPath: text.includes(${JSON.stringify(expectedPath)}),
      containsRedaction: text.includes("Bearer ••••••••"),
      containsKey: text.includes(key) ||
        document.documentElement.outerHTML.includes(key)
    };
  })()`);
  assert(check.containsPath, `raw request does not show ${expectedPath}`);
  assert(check.containsRedaction, "raw request does not redact Authorization");
  assert(
    !check.containsKey,
    "raw request or rendered DOM contains the API key",
  );
}

function hasPublicRequest(
  requests: BrowserNetworkRequest[],
  method: string,
  path: string | RegExp,
) {
  return requests.some((request) =>
    request.method === method &&
    (typeof path === "string"
      ? request.pathname === path
      : path.test(request.pathname))
  );
}

async function testPlaygroundWorkflows(
  client: CdpClient,
  gatewayBaseUrl: string,
  fake: FakeAgnesServer,
  pngPath: string,
  timeoutMs: number,
) {
  const phaseTimeout = Math.min(timeoutMs, 60_000);
  const key = `sk-agnes-browser-e2e-${crypto.randomUUID()}`;
  const gatewayOrigin = new URL(gatewayBaseUrl).origin;
  const publicRequests: BrowserNetworkRequest[] = [];
  const removeNetworkListener = client.on(
    "Network.requestWillBeSent",
    (params) => {
      const event = params as {
        request?: { method?: string; url?: string };
      };
      if (!event.request?.method || !event.request.url) return;
      try {
        const url = new URL(event.request.url);
        if (url.origin === gatewayOrigin && url.pathname.startsWith("/v1/")) {
          publicRequests.push({
            method: event.request.method,
            pathname: url.pathname,
          });
        }
      } catch {
        // Ignore browser-internal and malformed diagnostic URLs.
      }
    },
  );

  try {
    const locale = await client.evaluate<string>(
      `document.documentElement.lang`,
    );
    if (locale !== "en") {
      await client.evaluate(
        `document.querySelector(".locale-button")?.click()`,
      );
      await waitForPageCondition(
        client,
        `document.documentElement.lang === "en"`,
        phaseTimeout,
        "English before playground E2E",
      );
    }
    await setFormValue(client, ".key-field input", key);

    // First leave a Chat SSE open long enough to exercise the real cancel UI.
    await selectWorkflow(client, 0, phaseTimeout);
    await setFormValue(client, ".request-panel textarea", "cancel-smoke");
    await submitPlayground(client);
    await waitForPageCondition(
      client,
      `(document.querySelector(".text-result")?.textContent ?? "")` +
        `.includes("cancel stream started")`,
      phaseTimeout,
      "the first Chat SSE event",
    );
    const cancelled = await client.evaluate<boolean>(`(() => {
      const button = document.querySelector(".request-panel .button-danger");
      if (!(button instanceof HTMLButtonElement)) return false;
      button.click();
      return true;
    })()`);
    assert(cancelled, "the Chat cancel control is unavailable");
    await waitForPageCondition(
      client,
      `document.querySelector(".result-badge.phase-cancelled") &&
        document.querySelector(".cancel-result")`,
      phaseTimeout,
      "the cancelled playground state",
    );

    // Complete a second SSE request and inspect its sanitized request view.
    await setFormValue(client, ".request-panel textarea", "chat-success-smoke");
    await submitPlayground(client);
    await waitForPageCondition(
      client,
      `document.querySelector(".result-badge.phase-success") &&
        (document.querySelector(".text-result")?.textContent ?? "") ===
          "browser smoke chat"`,
      phaseTimeout,
      "the completed Chat SSE result",
    );
    await assertRawRequestRedacted(
      client,
      key,
      "/v1/chat/completions",
      phaseTimeout,
    );

    await selectWorkflow(client, 1, phaseTimeout);
    await setFormValue(client, ".request-panel textarea", "image-smoke");
    await submitPlayground(client);
    await waitForPageCondition(
      client,
      `document.querySelector(".result-badge.phase-success") &&
        document.querySelector(".image-results img")?.complete &&
        document.querySelector(".image-results img")?.naturalWidth === 1`,
      phaseTimeout,
      "the generated image preview",
    );
    const imagePreview = await client.evaluate<boolean>(`(() => {
      const image = document.querySelector(".image-results img");
      const download = document.querySelector(".image-results a[download]");
      return image instanceof HTMLImageElement &&
        image.src.startsWith("data:image/png;base64,") &&
        download instanceof HTMLAnchorElement && Boolean(download.download);
    })()`);
    assert(imagePreview, "image generation lacks preview/download controls");

    await selectWorkflow(client, 2, phaseTimeout);
    await waitForPageCondition(
      client,
      `document.querySelector(".file-drop input[type=file]") instanceof
        HTMLInputElement`,
      phaseTimeout,
      "the image-edit file input",
    );
    await setPlaygroundFile(client, pngPath);
    await waitForPageCondition(
      client,
      `document.querySelector(".file-preview") instanceof HTMLElement`,
      phaseTimeout,
      "the uploaded image preview",
    );
    await setFormValue(client, ".request-panel textarea", "edit-smoke");
    await submitPlayground(client);
    await waitForPageCondition(
      client,
      `document.querySelector(".result-badge.phase-success") &&
        document.querySelector(".image-results img")?.naturalWidth === 1`,
      phaseTimeout,
      "the edited image preview",
    );
    await assertRawRequestRedacted(
      client,
      key,
      "/v1/images/edits",
      phaseTimeout,
    );

    await selectWorkflow(client, 3, phaseTimeout);
    await setFormValue(client, ".request-panel textarea", "text-video-smoke");
    await submitPlayground(client);
    await waitForPageCondition(
      client,
      `document.querySelector(".result-badge.phase-success") &&
        document.querySelector(".video-result video")?.src.startsWith("blob:")`,
      phaseTimeout,
      "the text-to-video lifecycle",
    );
    const textVideoPreview = await client.evaluate<boolean>(`(() => {
      const video = document.querySelector(".video-result video");
      const download = document.querySelector(".video-result a[download]");
      const open = document.querySelector(".video-result a[target=_blank]");
      return video instanceof HTMLVideoElement && video.src.startsWith("blob:") &&
        download instanceof HTMLAnchorElement && Boolean(download.download) &&
        open instanceof HTMLAnchorElement && open.href === video.src;
    })()`);
    assert(
      textVideoPreview,
      "text-to-video lacks Blob preview/download/open controls",
    );

    await selectWorkflow(client, 4, phaseTimeout);
    await waitForPageCondition(
      client,
      `document.querySelector(".file-preview") instanceof HTMLElement`,
      phaseTimeout,
      "the retained image-to-video reference preview",
    );
    await setFormValue(client, ".request-panel textarea", "image-video-smoke");
    await submitPlayground(client);
    await waitForPageCondition(
      client,
      `document.querySelector(".result-badge.phase-success") &&
        document.querySelector(".video-result video")?.src.startsWith("blob:")`,
      phaseTimeout,
      "the image-to-video lifecycle",
    );

    assert(
      hasPublicRequest(publicRequests, "POST", "/v1/chat/completions") &&
        hasPublicRequest(publicRequests, "POST", "/v1/images/generations") &&
        hasPublicRequest(publicRequests, "POST", "/v1/images/edits") &&
        hasPublicRequest(publicRequests, "POST", "/v1/videos") &&
        hasPublicRequest(publicRequests, "GET", /^\/v1\/videos\/[^/]+$/) &&
        hasPublicRequest(
          publicRequests,
          "GET",
          /^\/v1\/videos\/[^/]+\/content$/,
        ),
      "the browser did not exercise all six public API routes",
    );

    const apiRequests = fake.requests.filter((request) =>
      request.path.startsWith("/v1/")
    );
    const mediaRequests = fake.requests.filter((request) =>
      request.path.startsWith("/media/")
    );
    assert(
      apiRequests.every((request) => request.authorization === `Bearer ${key}`),
      "the synthetic caller credential was not forwarded to every fake API call",
    );
    assert(
      mediaRequests.length === 2 &&
        mediaRequests.every((request) => request.authorization === null),
      "video media requests must omit Authorization",
    );
    const imageBodies = apiRequests.filter((request) =>
      request.method === "POST" && request.path === "/v1/images/generations"
    ).map((request) => request.body);
    assert(
      imageBodies.length === 2,
      "image generation/edit upstream calls missing",
    );
    const editBody = imageBodies.find((body) => {
      const extra = body?.extra_body;
      return extra && typeof extra === "object" &&
        Array.isArray((extra as Record<string, unknown>).image);
    });
    assert(
      Boolean(editBody) &&
        JSON.stringify(editBody).includes("data:image/png;base64,"),
      "multipart image edit was not converted to an upstream Data URI",
    );
    const videoBodies = apiRequests.filter((request) =>
      request.method === "POST" && request.path === "/v1/videos"
    ).map((request) => request.body);
    assert(
      videoBodies.length === 2 && videoBodies.some((body) => !body?.image) &&
        videoBodies.some((body) =>
          typeof body?.image === "string" &&
          body.image.startsWith("data:image/png;base64,")
        ),
      "text/image video requests were not transformed distinctly",
    );
    console.log(
      "✓ Five playground workflows exercise all six routes via fake Agnes",
    );
  } finally {
    removeNetworkListener();
  }
}

async function testCredentialPersistence(client: CdpClient, timeoutMs: number) {
  // This is a synthetic marker, never an Agnes credential. Its literal value is
  // intentionally kept out of logs and assertion messages.
  const sentinel = `sk-agnes-browser-smoke-${crypto.randomUUID()}`;
  const encodedSentinel = JSON.stringify(sentinel);
  const accepted = await client.evaluate<boolean>(`(() => {
    const input = document.querySelector(".key-field input");
    if (!(input instanceof HTMLInputElement)) return false;
    input.value = ${encodedSentinel};
    input.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: null
    }));
    return input.type === "password" && input.value === ${encodedSentinel};
  })()`);
  assert(
    accepted,
    "the in-memory API key field did not accept the test marker",
  );

  // Force a Preact rerender after input so accidental state-to-markup leakage is
  // observable before inspecting the DOM and browser persistence mechanisms.
  await client.evaluate(`document.querySelector(".locale-button")?.click()`);
  await waitForPageCondition(
    client,
    `document.documentElement.lang === "zh-Hans"`,
    timeoutMs,
    "a rerender after entering the API key marker",
  );

  const scan = await client.evaluate<CredentialScan>(`(() => {
    const sentinel = ${encodedSentinel};
    const keyInput = document.querySelector(".key-field input");
    const storageContains = (storage) => {
      for (let index = 0; index < storage.length; index++) {
        const name = storage.key(index) ?? "";
        const value = storage.getItem(name) ?? "";
        if (name.includes(sentinel) || value.includes(sentinel)) return true;
      }
      return false;
    };
    const attributeContainsSentinel = Array.from(
      document.querySelectorAll("*")
    ).some((element) => Array.from(element.attributes).some((attribute) =>
      attribute.value.includes(sentinel)
    ));
    const otherFieldContainsSentinel = Array.from(
      document.querySelectorAll("input, textarea, select")
    ).some((field) => field !== keyInput && "value" in field &&
      String(field.value).includes(sentinel));
    return {
      inputContainsSentinel: keyInput instanceof HTMLInputElement &&
        keyInput.value === sentinel,
      localStorageContainsSentinel: storageContains(localStorage),
      sessionStorageContainsSentinel: storageContains(sessionStorage),
      cookieContainsSentinel: document.cookie.includes(sentinel),
      serializedDomContainsSentinel:
        document.documentElement.outerHTML.includes(sentinel),
      textContainsSentinel:
        (document.body.textContent ?? "").includes(sentinel),
      attributeContainsSentinel,
      otherFieldContainsSentinel
    };
  })()`);

  assert(
    scan.inputContainsSentinel,
    "the key marker was lost before inspection",
  );
  assert(
    !scan.localStorageContainsSentinel,
    "the API key marker entered localStorage",
  );
  assert(
    !scan.sessionStorageContainsSentinel,
    "the API key marker entered sessionStorage",
  );
  assert(!scan.cookieContainsSentinel, "the API key marker entered cookies");
  assert(
    !scan.serializedDomContainsSentinel && !scan.textContainsSentinel &&
      !scan.attributeContainsSentinel && !scan.otherFieldContainsSentinel,
    "the API key marker leaked from the password field into rendered DOM",
  );

  await client.evaluate(`document.querySelector(".clear-button")?.click()`);
  await waitForPageCondition(
    client,
    `document.querySelector(".key-field input")?.value === ""`,
    timeoutMs,
    "the clear-sensitive-data action",
  );
  console.log(
    "✓ API key remains only in component/input memory and clears on demand",
  );
}

async function main() {
  const timeoutMs = parsePositiveInteger(
    Deno.env.get("BROWSER_SMOKE_TIMEOUT_MS"),
    DEFAULT_TIMEOUT_MS,
  );
  const chromiumPath = await resolveChromiumPath();
  console.log(`Using Chromium: ${chromiumPath}`);
  const configuredBaseUrl = Deno.env.get("BROWSER_SMOKE_BASE_URL")?.replace(
    /\/+$/,
    "",
  );
  if (configuredBaseUrl) {
    const parsed = new URL(configuredBaseUrl);
    assert(
      parsed.protocol === "http:" || parsed.protocol === "https:",
      "BROWSER_SMOKE_BASE_URL must use http:// or https://",
    );
  }

  let server: ChildHandle | undefined;
  let browser: ChildHandle | undefined;
  let profile: string | undefined;
  let client: CdpClient | undefined;
  let devtoolsUrl: string | undefined;
  let targetId: string | undefined;
  let fakeAgnes: FakeAgnesServer | undefined;
  let pngPath: string | undefined;

  try {
    if (!configuredBaseUrl) {
      fakeAgnes = await startFakeAgnes(timeoutMs);
      pngPath = await Deno.makeTempFile({
        prefix: "agnes-browser-smoke-",
        suffix: ".png",
      });
      await Deno.writeFile(
        pngPath,
        Uint8Array.from(
          atob(TEST_PNG_BASE64),
          (character) => character.charCodeAt(0),
        ),
      );
    }
    const serverResult = configuredBaseUrl
      ? { baseUrl: configuredBaseUrl, server: undefined }
      : await startLocalServer(timeoutMs, fakeAgnes!.baseUrl);
    server = serverResult.server;
    await waitForHttp(`${serverResult.baseUrl}/healthz`, timeoutMs);

    const browserResult = await startChromium(chromiumPath, timeoutMs);
    browser = browserResult.browser;
    profile = browserResult.profile;
    devtoolsUrl = browserResult.devtoolsUrl;
    const page = await createPageClient(devtoolsUrl, timeoutMs);
    client = page.client;
    targetId = page.targetId;

    await Promise.all([
      client.call("Page.enable"),
      client.call("Runtime.enable"),
      client.call("Network.enable"),
      client.call("DOM.enable"),
    ]);
    await client.call("Network.setCacheDisabled", { cacheDisabled: true });
    const loaded = client.waitForEvent("Page.loadEventFired", timeoutMs);
    const navigation = await client.call("Page.navigate", {
      url: `${serverResult.baseUrl}/`,
    }) as { errorText?: string };
    assert(
      !navigation.errorText,
      `page navigation failed: ${navigation.errorText}`,
    );
    await loaded;
    await waitForPageCondition(
      client,
      `document.readyState === "complete" &&
        document.querySelector(".locale-button") instanceof HTMLButtonElement &&
        document.querySelector(".key-field input") instanceof HTMLInputElement`,
      timeoutMs,
      "the hydrated landing page",
    );

    await testLanguages(client, timeoutMs);
    await testSimplifiedPage(
      client,
      new URL(serverResult.baseUrl).origin,
    );
    await testViewports(client);
    await testKeyboardAccessibility(client);
    await testReducedMotion(client);
    if (fakeAgnes && pngPath) {
      await testPlaygroundWorkflows(
        client,
        serverResult.baseUrl,
        fakeAgnes,
        pngPath,
        timeoutMs,
      );
    } else {
      console.log(
        "↷ Playground workflow E2E skipped for an externally managed gateway",
      );
    }
    await testCredentialPersistence(client, timeoutMs);
    console.log("Browser smoke passed.");
  } finally {
    client?.close();
    if (devtoolsUrl && targetId) {
      await fetch(`${devtoolsUrl}/json/close/${targetId}`).catch(() =>
        undefined
      );
    }
    await stopChild(browser);
    if (profile) {
      await Deno.remove(profile, { recursive: true }).catch(() => undefined);
    }
    await stopChild(server);
    await fakeAgnes?.close();
    if (pngPath) await Deno.remove(pngPath).catch(() => undefined);
  }
}

if (import.meta.main) {
  await main();
}
