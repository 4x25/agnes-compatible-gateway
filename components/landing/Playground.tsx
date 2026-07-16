import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { CopyButton } from "./CopyButton.tsx";
import { COPY, DEFAULT_MODELS, ENDPOINTS } from "./content.ts";
import { Icon } from "./Icon.tsx";
import type { Locale, ResultState, UploadedImage, Workflow } from "./types.ts";

interface PlaygroundProps {
  locale: Locale;
  copy: typeof COPY[Locale];
}

type ValidationErrors = Partial<
  Record<"key" | "model" | "prompt" | "image" | "base", string>
>;

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_IMAGE_SIZE = 20 * 1024 * 1024;
const TERMINAL_VIDEO_STATUSES = new Set([
  "completed",
  "succeeded",
  "success",
  "done",
]);
const FAILED_VIDEO_STATUSES = new Set([
  "failed",
  "error",
  "cancelled",
  "canceled",
]);

function joinApiUrl(base: string, path: string) {
  const cleanBase = base.replace(/\/+$/, "");
  // Accept both an origin and the conventional OpenAI `baseURL` ending in /v1.
  if (cleanBase.endsWith("/v1") && path.startsWith("/v1/")) {
    return `${cleanBase}${path.slice(3)}`;
  }
  return `${cleanBase}${path}`;
}

function isValidBaseUrl(value: string) {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username && !url.password && !url.search && !url.hash &&
      !value.includes("?") && !value.includes("#");
  } catch {
    return false;
  }
}

function requestIdFrom(headers: Headers) {
  return headers.get("x-request-id") ?? headers.get("x-agnes-request-id") ??
    headers.get("request-id") ?? undefined;
}

function extractError(payload: unknown, fallback: string) {
  if (typeof payload === "string" && payload.trim()) return payload;
  if (!payload || typeof payload !== "object") return fallback;
  const record = payload as Record<string, unknown>;
  const nested = record.error;
  if (nested && typeof nested === "object") {
    const message = (nested as Record<string, unknown>).message;
    if (typeof message === "string" && message) return message;
  }
  if (typeof record.message === "string" && record.message) {
    return record.message;
  }
  return fallback;
}

async function parseResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function extractChatText(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const record = payload as Record<string, unknown>;
  const choices = record.choices;
  if (!Array.isArray(choices) || !choices.length) return "";
  const first = choices[0] as Record<string, unknown>;
  const source = (first.delta ?? first.message) as
    | Record<string, unknown>
    | undefined;
  const content = source?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (!part || typeof part !== "object") return "";
      const item = part as Record<string, unknown>;
      return typeof item.text === "string" ? item.text : "";
    }).join("");
  }
  return "";
}

function extractImageUrls(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];
  const record = payload as Record<string, unknown>;
  const candidates = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.images)
    ? record.images
    : [];
  return candidates.flatMap((entry) => {
    if (typeof entry === "string") return [entry];
    if (!entry || typeof entry !== "object") return [];
    const image = entry as Record<string, unknown>;
    if (typeof image.url === "string") return [image.url];
    if (typeof image.b64_json === "string") {
      return [`data:image/png;base64,${image.b64_json}`];
    }
    return [];
  });
}

/** Keep media available for preview without duplicating multi-megabyte base64 in JSON debug state. */
function omitEmbeddedMedia(value: unknown, key = ""): unknown {
  if (typeof value === "string") {
    const isEncodedField = /(?:b64|base64)/i.test(key);
    const isDataUri = value.startsWith("data:image/") ||
      value.startsWith("data:video/");
    if (isEncodedField || isDataUri) {
      return `[embedded media omitted: ${value.length} chars]`;
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => omitEmbeddedMedia(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([name, item]) => [
        name,
        omitEmbeddedMedia(item, name),
      ]),
    );
  }
  return value;
}

function videoIdFrom(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const record = payload as Record<string, unknown>;
  for (const key of ["id", "task_id", "video_id"]) {
    if (typeof record[key] === "string" && record[key]) {
      return record[key] as string;
    }
  }
  const data = record.data;
  if (data && typeof data === "object") return videoIdFrom(data);
  return undefined;
}

function videoStatusFrom(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "queued";
  const record = payload as Record<string, unknown>;
  const direct = record.status ?? record.state;
  if (typeof direct === "string") return direct.toLowerCase();
  if (record.data && typeof record.data === "object") {
    return videoStatusFrom(record.data);
  }
  return "queued";
}

function progressFrom(payload: unknown): number | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const record = payload as Record<string, unknown>;
  const raw = record.progress ?? record.progress_percent;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.max(0, Math.min(100, raw <= 1 ? raw * 100 : raw));
  }
  if (record.data && typeof record.data === "object") {
    return progressFrom(record.data);
  }
  return undefined;
}

function abortableDelay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = globalThis.setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}

function pretty(value: unknown) {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

function isVideoWorkflow(workflow: Workflow) {
  return workflow === "textVideo" || workflow === "imageVideo";
}

/**
 * A real, browser-side API client. Credential and response state deliberately
 * live only in Preact memory; the sole persisted value here is the selected tab.
 */
export function Playground({ locale, copy }: PlaygroundProps) {
  const [workflow, setWorkflowState] = useState<Workflow>("chat");
  const [key, setKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [baseUrl, setBaseUrl] = useState("");
  const [models, setModels] = useState({ ...DEFAULT_MODELS });
  const [prompt, setPrompt] = useState("");
  const [stream, setStream] = useState(true);
  const [size, setSize] = useState("1024x1024");
  const [count, setCount] = useState(1);
  const [seconds, setSeconds] = useState(4);
  const [upload, setUpload] = useState<UploadedImage>();
  const [errors, setErrors] = useState<ValidationErrors>({});
  const [result, setResult] = useState<ResultState>({ phase: "idle" });
  const [sanitizedRequest, setSanitizedRequest] = useState<unknown>();
  const [rawOpen, setRawOpen] = useState(false);
  const controllerRef = useRef<AbortController>();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const objectUrlsRef = useRef<string[]>([]);
  const startedAtRef = useRef(0);

  const endpoint = ENDPOINTS.find((entry) => entry.id === workflow)!;
  const currentModel = models[workflow];
  const destination = baseUrl && isValidBaseUrl(baseUrl)
    ? joinApiUrl(baseUrl, endpoint.path)
    : endpoint.path;

  useEffect(() => {
    const stored = localStorage.getItem("agnes-gateway.endpoint") as
      | Workflow
      | null;
    if (stored && ENDPOINTS.some((item) => item.id === stored)) {
      setWorkflowState(stored);
    }
    setBaseUrl(globalThis.location.origin);
  }, []);

  useEffect(() => () => {
    controllerRef.current?.abort();
    if (upload) URL.revokeObjectURL(upload.previewUrl);
    objectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
  }, [upload]);

  function setWorkflow(next: Workflow) {
    if (result.phase === "requesting" || result.phase === "polling") {
      controllerRef.current?.abort();
    }
    setWorkflowState(next);
    localStorage.setItem("agnes-gateway.endpoint", next);
    setResult({ phase: "idle" });
    setSanitizedRequest(undefined);
    setErrors({});
    setSize(isVideoWorkflow(next) ? "720x1280" : "1024x1024");
  }

  function updateModel(value: string) {
    setModels((current) => ({ ...current, [workflow]: value }));
  }

  function handleFile(file?: File) {
    setErrors((current) => ({ ...current, image: undefined }));
    if (!file) return;
    if (!IMAGE_TYPES.has(file.type) || file.size > MAX_IMAGE_SIZE) {
      setErrors((current) => ({
        ...current,
        image: copy.playground.invalidImage,
      }));
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }
    if (upload) URL.revokeObjectURL(upload.previewUrl);
    setUpload({ file, previewUrl: URL.createObjectURL(file) });
  }

  function removeFile() {
    if (upload) URL.revokeObjectURL(upload.previewUrl);
    setUpload(undefined);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function validate() {
    const next: ValidationErrors = {};
    if (!key.trim()) next.key = copy.playground.requiredKey;
    if (!currentModel.trim()) next.model = copy.playground.requiredModel;
    if (!prompt.trim()) next.prompt = copy.playground.requiredPrompt;
    if (!isValidBaseUrl(baseUrl)) next.base = copy.playground.invalidBase;
    if ((workflow === "edit" || workflow === "imageVideo") && !upload) {
      next.image = copy.playground.requiredImage;
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  function stop() {
    controllerRef.current?.abort();
    setResult((current) => ({
      ...current,
      phase: "cancelled",
      durationMs: performance.now() - startedAtRef.current,
    }));
  }

  function clearSensitiveData() {
    controllerRef.current?.abort();
    setKey("");
    setShowKey(false);
    setPrompt("");
    removeFile();
    objectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    objectUrlsRef.current = [];
    setResult({ phase: "idle" });
    setSanitizedRequest(undefined);
    setErrors({});
  }

  async function send() {
    if (!validate()) return;
    controllerRef.current?.abort();
    objectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    objectUrlsRef.current = [];

    const controller = new AbortController();
    controllerRef.current = controller;
    startedAtRef.current = performance.now();
    setRawOpen(false);
    setResult({ phase: "requesting" });

    try {
      if (workflow === "chat") {
        await sendChat(controller);
      } else if (workflow === "image" || workflow === "edit") {
        await sendImage(controller);
      } else {
        await sendVideo(controller);
      }
    } catch (error) {
      if ((error as DOMException)?.name === "AbortError") return;
      setResult((current) => ({
        ...current,
        phase: "error",
        durationMs: performance.now() - startedAtRef.current,
        error: error instanceof Error ? error.message : copy.playground.failed,
      }));
    }
  }

  async function sendChat(controller: AbortController) {
    const body = {
      model: currentModel.trim(),
      messages: [{ role: "user", content: prompt.trim() }],
      stream,
    };
    setSanitizedRequest({
      method: "POST",
      url: joinApiUrl(baseUrl, endpoint.path),
      headers: {
        Authorization: "Bearer ••••••••",
        "Content-Type": "application/json",
      },
      body,
    });
    const response = await fetch(joinApiUrl(baseUrl, endpoint.path), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key.trim()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const metadata = {
      status: response.status,
      requestId: requestIdFrom(response.headers),
    };
    if (!response.ok) {
      const payload = await parseResponse(response);
      throw new Error(
        extractError(payload, `${copy.playground.failed} (${response.status})`),
      );
    }

    if (!stream || !response.body) {
      const payload = await parseResponse(response);
      setResult({
        phase: "success",
        ...metadata,
        durationMs: performance.now() - startedAtRef.current,
        text: extractChatText(payload),
        raw: payload,
      });
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const events: unknown[] = [];
    let buffer = "";
    let output = "";

    function processEvent(block: string) {
      const data = block.split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data || data === "[DONE]") return;
      try {
        const payload = JSON.parse(data);
        events.push(payload);
        output += extractChatText(payload);
        setResult({
          phase: "requesting",
          ...metadata,
          durationMs: performance.now() - startedAtRef.current,
          text: output,
          raw: { events },
        });
      } catch {
        events.push(data);
      }
    }

    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() ?? "";
      blocks.forEach(processEvent);
      if (done) break;
    }
    if (buffer.trim()) processEvent(buffer);
    setResult({
      phase: "success",
      ...metadata,
      durationMs: performance.now() - startedAtRef.current,
      text: output,
      raw: { events, done: true },
    });
  }

  async function sendImage(controller: AbortController) {
    const url = joinApiUrl(baseUrl, endpoint.path);
    const common = {
      model: currentModel.trim(),
      prompt: prompt.trim(),
      size,
      n: count,
      response_format: "b64_json",
    };
    let body: BodyInit;
    let headers: HeadersInit = { Authorization: `Bearer ${key.trim()}` };

    if (workflow === "edit") {
      const form = new FormData();
      form.append("model", common.model);
      form.append("prompt", common.prompt);
      form.append("size", common.size);
      form.append("n", String(common.n));
      form.append("response_format", common.response_format);
      form.append("image", upload!.file, upload!.file.name);
      body = form;
      setSanitizedRequest({
        method: "POST",
        url,
        headers: {
          Authorization: "Bearer ••••••••",
          "Content-Type": "multipart/form-data",
        },
        body: {
          ...common,
          image: {
            name: upload!.file.name,
            type: upload!.file.type,
            size: upload!.file.size,
          },
        },
      });
    } else {
      headers = { ...headers, "Content-Type": "application/json" };
      body = JSON.stringify(common);
      setSanitizedRequest({
        method: "POST",
        url,
        headers: {
          Authorization: "Bearer ••••••••",
          "Content-Type": "application/json",
        },
        body: common,
      });
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
    const payload = await parseResponse(response);
    if (!response.ok) {
      throw new Error(
        extractError(payload, `${copy.playground.failed} (${response.status})`),
      );
    }
    setResult({
      phase: "success",
      status: response.status,
      requestId: requestIdFrom(response.headers),
      durationMs: performance.now() - startedAtRef.current,
      imageUrls: extractImageUrls(payload),
      raw: omitEmbeddedMedia(payload),
    });
  }

  async function sendVideo(controller: AbortController) {
    const url = joinApiUrl(baseUrl, endpoint.path);
    const common = {
      model: currentModel.trim(),
      prompt: prompt.trim(),
      seconds: String(seconds),
      size,
    };
    let body: BodyInit;
    let headers: HeadersInit = { Authorization: `Bearer ${key.trim()}` };
    if (workflow === "imageVideo") {
      const form = new FormData();
      Object.entries(common).forEach(([name, value]) =>
        form.append(name, value)
      );
      form.append("input_reference", upload!.file, upload!.file.name);
      body = form;
      setSanitizedRequest({
        method: "POST",
        url,
        headers: {
          Authorization: "Bearer ••••••••",
          "Content-Type": "multipart/form-data",
        },
        body: {
          ...common,
          input_reference: {
            name: upload!.file.name,
            type: upload!.file.type,
            size: upload!.file.size,
          },
        },
      });
    } else {
      headers = { ...headers, "Content-Type": "application/json" };
      body = JSON.stringify(common);
      setSanitizedRequest({
        method: "POST",
        url,
        headers: {
          Authorization: "Bearer ••••••••",
          "Content-Type": "application/json",
        },
        body: common,
      });
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
    const created = await parseResponse(response);
    if (!response.ok) {
      throw new Error(
        extractError(created, `${copy.playground.failed} (${response.status})`),
      );
    }
    const taskId = videoIdFrom(created);
    if (!taskId) {
      throw new Error(`${copy.playground.failed}: missing video task ID`);
    }
    setResult({
      phase: "polling",
      status: response.status,
      requestId: requestIdFrom(response.headers),
      taskId,
      raw: { create: created },
    });
    await pollVideo(taskId, created, controller);
  }

  async function pollVideo(
    taskId: string,
    created: unknown,
    controller: AbortController,
  ) {
    const deadline = Date.now() + 15 * 60 * 1000;
    let last: unknown = created;
    let pollStatus = 200;
    while (Date.now() < deadline) {
      await abortableDelay(2000, controller.signal);
      const retrieveUrl = joinApiUrl(
        baseUrl,
        `/v1/videos/${encodeURIComponent(taskId)}`,
      );
      const response = await fetch(retrieveUrl, {
        headers: { Authorization: `Bearer ${key.trim()}` },
        signal: controller.signal,
      });
      last = await parseResponse(response);
      pollStatus = response.status;
      if (!response.ok) {
        throw new Error(
          extractError(last, `${copy.playground.failed} (${response.status})`),
        );
      }
      const status = videoStatusFrom(last);
      setResult({
        phase: "polling",
        status: pollStatus,
        requestId: requestIdFrom(response.headers),
        taskId,
        progress: progressFrom(last),
        durationMs: performance.now() - startedAtRef.current,
        raw: { create: created, retrieve: last },
      });
      if (FAILED_VIDEO_STATUSES.has(status)) {
        throw new Error(
          extractError(last, `${copy.playground.failed}: ${status}`),
        );
      }
      if (TERMINAL_VIDEO_STATUSES.has(status)) break;
    }
    if (!TERMINAL_VIDEO_STATUSES.has(videoStatusFrom(last))) {
      throw new Error(
        `${copy.playground.failed}: polling timed out after 15 minutes`,
      );
    }

    // Fetch through the authenticated content route; <video src> cannot attach
    // Authorization itself. The temporary Blob URL is revoked on retry/unmount.
    const contentUrl = joinApiUrl(
      baseUrl,
      `/v1/videos/${encodeURIComponent(taskId)}/content`,
    );
    const mediaResponse = await fetch(contentUrl, {
      headers: { Authorization: `Bearer ${key.trim()}` },
      signal: controller.signal,
    });
    if (!mediaResponse.ok) {
      const payload = await parseResponse(mediaResponse);
      throw new Error(
        extractError(
          payload,
          `${copy.playground.failed} (${mediaResponse.status})`,
        ),
      );
    }
    const blobUrl = URL.createObjectURL(await mediaResponse.blob());
    objectUrlsRef.current.push(blobUrl);
    setResult({
      phase: "success",
      status: pollStatus,
      requestId: requestIdFrom(mediaResponse.headers),
      taskId,
      progress: 100,
      durationMs: performance.now() - startedAtRef.current,
      videoUrl: blobUrl,
      raw: { create: created, retrieve: last },
    });
  }

  const requestJson = useMemo(() => pretty(sanitizedRequest), [
    sanitizedRequest,
  ]);
  const responseJson = useMemo(() => pretty(result.raw), [result.raw]);
  const busy = result.phase === "requesting" || result.phase === "polling";

  return (
    <section
      id="playground"
      class="section playground-section"
      aria-labelledby="playground-title"
    >
      <div class="shell">
        <div class="section-heading split-heading">
          <div>
            <p class="eyebrow">{copy.playground.eyebrow}</p>
            <h2 id="playground-title">{copy.playground.title}</h2>
          </div>
          <p>{copy.playground.intro}</p>
        </div>

        <div class="security-strip">
          <Icon name="key" size={22} />
          <label class="key-field">
            <span>{copy.playground.key}</span>
            <input
              type={showKey ? "text" : "password"}
              value={key}
              onInput={(event) => {
                setKey(event.currentTarget.value);
                setErrors((current) => ({ ...current, key: undefined }));
              }}
              placeholder="sk-agnes-••••••••"
              autocomplete="off"
              autocapitalize="none"
              spellcheck={false}
              aria-invalid={Boolean(errors.key)}
              aria-describedby={errors.key ? "key-error" : "key-hint"}
            />
          </label>
          <button
            type="button"
            class="icon-button field-action"
            onClick={() => setShowKey(!showKey)}
            aria-label={showKey ? copy.playground.hide : copy.playground.show}
          >
            <Icon name={showKey ? "eyeOff" : "eye"} />
          </button>
          <button
            type="button"
            class="clear-button"
            onClick={clearSensitiveData}
          >
            <Icon name="trash" size={16} />
            {copy.playground.clear}
          </button>
          <p
            id={errors.key ? "key-error" : "key-hint"}
            class={errors.key ? "field-error" : "field-hint"}
          >
            {errors.key ?? copy.playground.keyHint}
          </p>
        </div>

        <details class="connection-settings">
          <summary>
            <Icon name="chevron" />
            {copy.playground.advanced}
          </summary>
          <div class="connection-grid">
            <label class="form-field">
              <span>{copy.playground.base}</span>
              <input
                type="url"
                inputMode="url"
                value={baseUrl}
                onInput={(event) => {
                  setBaseUrl(event.currentTarget.value);
                  setErrors((current) => ({ ...current, base: undefined }));
                }}
                aria-invalid={Boolean(errors.base)}
                aria-describedby={errors.base ? "base-error" : "base-hint"}
              />
              <small
                id={errors.base ? "base-error" : "base-hint"}
                class={errors.base ? "field-error" : ""}
              >
                {errors.base ?? copy.playground.baseHint}
              </small>
            </label>
            <div class="destination-card">
              <span>{copy.playground.destination}</span>
              <code>{destination}</code>
            </div>
          </div>
        </details>

        <div
          class="endpoint-tabs endpoint-tabs-light"
          role="tablist"
          aria-label="Live request workflow"
        >
          {ENDPOINTS.map((item, index) => (
            <button
              type="button"
              role="tab"
              key={item.id}
              aria-selected={workflow === item.id}
              class={workflow === item.id ? "active" : ""}
              onClick={() => setWorkflow(item.id)}
            >
              <span>0{index + 1}</span>
              {item.labels[locale]}
            </button>
          ))}
        </div>

        <div class="playground-grid">
          <form
            class="request-panel"
            onSubmit={(event) => {
              event.preventDefault();
              send();
            }}
          >
            <div class="panel-title">
              <span>
                <Icon name="send" size={17} />
                {copy.playground.request}
              </span>
              <code>
                <b>{endpoint.method}</b> {endpoint.path}
              </code>
            </div>
            <div class="form-body">
              <label class="form-field">
                <span>
                  {copy.playground.model}
                  <em>required</em>
                </span>
                <input
                  value={currentModel}
                  onInput={(event) => {
                    updateModel(event.currentTarget.value);
                    setErrors((current) => ({ ...current, model: undefined }));
                  }}
                  spellcheck={false}
                  aria-invalid={Boolean(errors.model)}
                />
                {errors.model && (
                  <small class="field-error">{errors.model}</small>
                )}
              </label>

              <label class="form-field">
                <span>
                  {workflow === "chat"
                    ? copy.playground.message
                    : copy.playground.prompt}
                  <em>required</em>
                </span>
                <textarea
                  rows={5}
                  value={prompt}
                  onInput={(event) => {
                    setPrompt(event.currentTarget.value);
                    setErrors((current) => ({ ...current, prompt: undefined }));
                  }}
                  placeholder={workflow === "chat"
                    ? copy.playground.messagePlaceholder
                    : copy.playground.promptPlaceholder}
                  aria-invalid={Boolean(errors.prompt)}
                />
                {errors.prompt && (
                  <small class="field-error">{errors.prompt}</small>
                )}
              </label>

              {(workflow === "edit" || workflow === "imageVideo") && (
                <div class="form-field">
                  <span>
                    {copy.playground.image}
                    <em>required</em>
                  </span>
                  {!upload
                    ? (
                      <label
                        class={`file-drop ${errors.image ? "invalid" : ""}`}
                      >
                        <input
                          ref={fileInputRef}
                          type="file"
                          accept="image/png,image/jpeg,image/webp"
                          onChange={(event) =>
                            handleFile(event.currentTarget.files?.[0])}
                        />
                        <Icon name="upload" size={24} />
                        <b>{copy.playground.drop}</b>
                        <small>{copy.playground.fileLimit}</small>
                      </label>
                    )
                    : (
                      <div class="file-preview">
                        <img src={upload.previewUrl} alt="Selected reference" />
                        <div>
                          <b>{upload.file.name}</b>
                          <small>
                            {upload.file.type} ·{" "}
                            {(upload.file.size / 1024 / 1024).toFixed(2)} MiB
                          </small>
                        </div>
                        <button
                          type="button"
                          onClick={removeFile}
                          aria-label={copy.playground.remove}
                        >
                          <Icon name="close" />
                        </button>
                      </div>
                    )}
                  {errors.image && (
                    <small class="field-error">{errors.image}</small>
                  )}
                </div>
              )}

              <div class="parameter-grid">
                {workflow === "chat"
                  ? (
                    <label class="toggle-field">
                      <input
                        type="checkbox"
                        checked={stream}
                        onChange={(event) =>
                          setStream(event.currentTarget.checked)}
                      />
                      <span aria-hidden="true" />
                      {copy.playground.stream}
                    </label>
                  )
                  : (
                    <label class="form-field compact-field">
                      <span>{copy.playground.size}</span>
                      <select
                        value={size}
                        onChange={(event) => setSize(event.currentTarget.value)}
                      >
                        {(isVideoWorkflow(workflow)
                          ? [
                            "720x1280",
                            "1280x720",
                            "1024x1792",
                            "1792x1024",
                          ]
                          : ["1024x1024", "1024x1536", "1536x1024"]).map((
                            option,
                          ) => <option key={option}>{option}</option>)}
                      </select>
                    </label>
                  )}
                {(workflow === "image" || workflow === "edit") && (
                  <label class="form-field compact-field">
                    <span>{copy.playground.count}</span>
                    <select
                      value={count}
                      onChange={(event) =>
                        setCount(Number(event.currentTarget.value))}
                    >
                      {[1, 2, 3, 4].map((option) => (
                        <option key={option} value={option}>{option}</option>
                      ))}
                    </select>
                  </label>
                )}
                {isVideoWorkflow(workflow) && (
                  <label class="form-field compact-field">
                    <span>{copy.playground.seconds}</span>
                    <select
                      value={seconds}
                      onChange={(event) =>
                        setSeconds(Number(event.currentTarget.value))}
                    >
                      {[4, 8, 12].map((option) => (
                        <option key={option} value={option}>{option}s</option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
            </div>
            <div class="panel-actions">
              {busy
                ? (
                  <button
                    type="button"
                    class="button button-danger"
                    onClick={stop}
                  >
                    <Icon name="stop" />
                    {copy.playground.cancel}
                  </button>
                )
                : (
                  <button type="submit" class="button button-primary">
                    <Icon name="play" />
                    {result.phase === "idle"
                      ? copy.playground.send
                      : copy.playground.retry}
                  </button>
                )}
              <span>{copy.playground.noPersistence}</span>
            </div>
          </form>

          <section
            class="result-panel"
            aria-labelledby="result-title"
            aria-live="polite"
          >
            <div class="panel-title">
              <span id="result-title">
                <Icon name="code" size={17} />
                {copy.playground.result}
              </span>
              <ResultBadge result={result} copy={copy} />
            </div>
            <ResultBody result={result} copy={copy} locale={locale} />
            {(sanitizedRequest !== undefined || result.raw !== undefined) && (
              <div class="raw-inspector">
                <button
                  type="button"
                  onClick={() => setRawOpen(!rawOpen)}
                  aria-expanded={rawOpen}
                >
                  <Icon name="chevron" />JSON / DEBUG
                </button>
                {rawOpen && (
                  <div class="raw-sections">
                    {sanitizedRequest !== undefined && (
                      <div>
                        <div class="raw-heading">
                          <span>{copy.playground.rawRequest}</span>
                          <CopyButton
                            value={requestJson}
                            label={copy.playground.copyJson}
                            copiedLabel={copy.hero.copied}
                          />
                        </div>
                        <pre><code>{requestJson}</code></pre>
                      </div>
                    )}
                    {result.raw !== undefined && (
                      <div>
                        <div class="raw-heading">
                          <span>{copy.playground.rawResponse}</span>
                          <CopyButton
                            value={responseJson}
                            label={copy.playground.copyJson}
                            copiedLabel={copy.hero.copied}
                          />
                        </div>
                        <pre><code>{responseJson}</code></pre>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </section>
        </div>
      </div>
    </section>
  );
}

function ResultBadge(
  { result, copy }: { result: ResultState; copy: typeof COPY[Locale] },
) {
  const labels = {
    idle: "READY",
    requesting: copy.playground.requesting,
    polling: copy.playground.polling,
    success: copy.playground.success,
    error: copy.playground.failed,
    cancelled: copy.playground.cancelled,
  };
  return (
    <span class={`result-badge phase-${result.phase}`}>
      <i />
      {labels[result.phase]}
    </span>
  );
}

function ResultBody(
  { result, copy, locale }: {
    result: ResultState;
    copy: typeof COPY[Locale];
    locale: Locale;
  },
) {
  if (result.phase === "idle") {
    return (
      <div class="result-empty">
        <div class="empty-glyph">
          <span>&lt;</span>
          <span>/</span>
          <span>&gt;</span>
        </div>
        <p>{copy.playground.empty}</p>
      </div>
    );
  }

  const metadata = [
    result.status !== undefined &&
    [copy.playground.status, String(result.status)],
    result.durationMs !== undefined &&
    [
      copy.playground.elapsed,
      result.durationMs < 1000
        ? `${Math.round(result.durationMs)} ms`
        : `${(result.durationMs / 1000).toFixed(1)} s`,
    ],
    result.taskId && [copy.playground.task, result.taskId],
    result.requestId && [copy.playground.requestId, result.requestId],
  ].filter(Boolean) as string[][];

  return (
    <div class="result-body">
      {metadata.length > 0 && (
        <dl class="result-meta">
          {metadata.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd title={value}>{value}</dd>
            </div>
          ))}
        </dl>
      )}

      {(result.phase === "requesting" || result.phase === "polling") && (
        <div class="request-progress">
          <span class="activity-line">
            <i />
            <i />
            <i />
          </span>
          <p>
            {result.phase === "polling"
              ? copy.playground.polling
              : copy.playground.requesting}
          </p>
          {result.progress !== undefined && (
            <div class="progress-block">
              <span>
                {copy.playground.progress}
                <b>{Math.round(result.progress)}%</b>
              </span>
              <progress value={result.progress} max="100" />
            </div>
          )}
        </div>
      )}

      {result.text && (
        <div class="text-result" lang={locale === "zh-CN" ? "zh-Hans" : "en"}>
          {result.text}
        </div>
      )}
      {result.imageUrls && result.imageUrls.length > 0 && (
        <div
          class={`image-results image-count-${
            Math.min(result.imageUrls.length, 4)
          }`}
        >
          {result.imageUrls.map((url, index) => (
            <figure key={`${index}-${url.slice(0, 20)}`}>
              <img src={url} alt={`Generated result ${index + 1}`} />
              <figcaption>
                <span>#{String(index + 1).padStart(2, "0")}</span>
                <a
                  href={url}
                  download={`agnes-image-${index + 1}.png`}
                  target="_blank"
                  rel="noreferrer"
                >
                  <Icon name="download" size={15} />
                  {copy.playground.download}
                </a>
              </figcaption>
            </figure>
          ))}
        </div>
      )}
      {result.videoUrl && (
        <figure class="video-result">
          <video src={result.videoUrl} controls playsInline preload="metadata">
            {/* Generated media does not provide a captions sidecar. */}
          </video>
          <figcaption>
            <a
              href={result.videoUrl}
              download={`agnes-video-${result.taskId ?? "result"}.mp4`}
            >
              <Icon name="download" size={15} />
              {copy.playground.download}
            </a>
            <a href={result.videoUrl} target="_blank" rel="noreferrer">
              <Icon name="external" size={15} />
              {copy.playground.openMedia}
            </a>
          </figcaption>
        </figure>
      )}
      {result.error && (
        <div class="error-result" role="alert">
          <strong>{copy.playground.failed}</strong>
          <p>{result.error}</p>
        </div>
      )}
      {result.phase === "cancelled" && (
        <div class="cancel-result">{copy.playground.cancelled}</div>
      )}
    </div>
  );
}
