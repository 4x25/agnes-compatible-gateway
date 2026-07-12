import { isRecord } from "../gateway/errors.ts";
import { parseHttpUrlWithoutUserinfo } from "../gateway/upstream.ts";

const CHAT_MODEL = "agnes-2.0-flash";
const IMAGE_MODEL = "agnes-image-2.1-flash";
const VIDEO_MODEL = "agnes-video-v2.0";
const GATEWAY_ORIGIN = "http://gateway.smoke";
const DEFAULT_REQUEST_TIMEOUT_MS = 6 * 60_000;
const CHAT_REQUEST_TIMEOUT_MS = 90_000;
const VIDEO_POLL_INTERVAL_MS = 20_000;
const VIDEO_TIMEOUT_MS = 12 * 60_000;
const PUBLIC_REFERENCE_IMAGE =
  "https://upload.wikimedia.org/wikipedia/commons/thumb/a/a9/Example.jpg/512px-Example.jpg";
const SAFE_ERROR_CODE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

class SmokeFailure extends Error {}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new SmokeFailure(message);
}

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "[::1]") return true;
  const octets = hostname.split(".");
  return octets.length === 4 && octets[0] === "127" &&
    octets.every((octet) => /^\d{1,3}$/.test(octet));
}

export function parseGatewayBaseUrl(value: string | undefined): URL {
  check(
    value !== undefined && value.trim().length > 0,
    "GATEWAY_URL is required in preview mode.",
  );

  const candidate = value.trim();
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new SmokeFailure("GATEWAY_URL must be an absolute URL.");
  }

  check(
    url.protocol === "http:" || url.protocol === "https:",
    "GATEWAY_URL must use HTTP or HTTPS.",
  );
  check(
    /^https?:\/\//i.test(candidate),
    "GATEWAY_URL must use a canonical HTTP(S) URL.",
  );
  check(
    url.protocol === "https:" || isLoopbackHostname(url.hostname),
    "GATEWAY_URL must use HTTPS unless it targets an explicit loopback host.",
  );
  const authorityStart = candidate.indexOf("://") + 3;
  const authorityEnd = candidate.slice(authorityStart).search(/[/?#]/);
  const authority = authorityEnd === -1
    ? candidate.slice(authorityStart)
    : candidate.slice(authorityStart, authorityStart + authorityEnd);
  check(
    !authority.includes("@") && url.username.length === 0 &&
      url.password.length === 0,
    "GATEWAY_URL must not contain credentials.",
  );
  check(
    !candidate.includes("?") && !candidate.includes("#"),
    "GATEWAY_URL must not contain a query or fragment.",
  );

  url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
  return url;
}

export function gatewayRequestUrl(baseUrl: URL, path: string): URL {
  return new URL(path.replace(/^\/+/, ""), baseUrl);
}

export function responseStatusSummary(
  response: Response,
  value: unknown,
): string {
  let code: string | undefined;
  if (isRecord(value) && isRecord(value.error)) {
    const candidate = value.error.code;
    if (
      typeof candidate === "string" && SAFE_ERROR_CODE.test(candidate) &&
      !/^(?:sk-|video_|task_)/i.test(candidate)
    ) {
      code = candidate;
    }
  }
  return code === undefined
    ? `HTTP ${response.status}`
    : `HTTP ${response.status}, code ${code}`;
}

export function hasOpenAIErrorEnvelope(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.error)) return false;
  const { message, type, param, code } = value.error;
  return typeof message === "string" && typeof type === "string" &&
    (param === null || typeof param === "string") &&
    (code === null || typeof code === "string");
}

export function hasExactImageUrlResults(
  value: unknown,
  expectedCount: number,
): boolean {
  return isRecord(value) && Array.isArray(value.data) &&
    value.data.length === expectedCount &&
    value.data.every((item) =>
      isRecord(item) && typeof item.url === "string" &&
      parseHttpUrlWithoutUserinfo(item.url) !== undefined
    );
}

export function enforcePreviewWarnings(
  previewMode: boolean,
  warningCount: number,
): void {
  if (previewMode && warningCount > 0) {
    throw new SmokeFailure(
      `Strict preview checks failed with ${warningCount} compatibility warning(s).`,
    );
  }
}

async function readSecretLine(): Promise<string> {
  const reader = Deno.stdin.readable.getReader();
  const decoder = new TextDecoder();
  let text = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      const newline = text.indexOf("\n");
      if (newline >= 0) return text.slice(0, newline).replace(/\r$/, "");
    }
    text += decoder.decode();
    return text.replace(/\r?\n$/, "");
  } finally {
    reader.releaseLock();
  }
}

async function jsonValue(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new SmokeFailure(
      `Expected a JSON response for HTTP ${response.status}.`,
    );
  }
}

function firstImageValue(value: unknown, field: "url" | "b64_json"): string {
  check(isRecord(value), "Image response must be an object.");
  check(
    Array.isArray(value.data) && value.data.length > 0,
    "Image data is empty.",
  );
  const first = value.data[0];
  check(isRecord(first), "Image result must be an object.");
  const result = first[field];
  check(
    typeof result === "string" && result.length > 0,
    `Image response lacks ${field}.`,
  );
  return result;
}

async function main(): Promise<void> {
  const previewMode = Deno.args.includes("--preview");
  const base64Only = Deno.args.includes("--base64-only");
  const editOnly = Deno.args.includes("--edit-only");
  const imageCountOnly = Deno.args.includes("--image-count-only");
  const contentOnlyArgument = Deno.args.find((value) =>
    value.startsWith("--content-id=")
  );
  const contentOnlyId = contentOnlyArgument?.slice("--content-id=".length);
  const videoOnly = Deno.args.includes("--video-only");
  const generatedVideoOnly = Deno.args.includes("--generated-video-only");
  const mediaOnly = Deno.args.includes("--media-only") || videoOnly ||
    generatedVideoOnly;
  const gatewayBaseUrl = previewMode
    ? parseGatewayBaseUrl(Deno.env.get("GATEWAY_URL"))
    : new URL(GATEWAY_ORIGIN);
  const handler = previewMode
    ? undefined
    : (await import("../gateway/app.ts")).createGatewayApp().handler();
  const key = (await readSecretLine()).trim();
  check(key.length > 0, "No API key was provided on stdin.");
  const authorization = `Bearer ${key}`;
  let warnings = 0;

  const request = async (
    path: string,
    init: RequestInit = {},
    authenticated = true,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<Response> => {
    const headers = new Headers(init.headers);
    if (authenticated) headers.set("authorization", authorization);
    const gatewayRequest = new Request(
      gatewayRequestUrl(gatewayBaseUrl, path),
      {
        ...init,
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      },
    );

    try {
      if (handler === undefined) return await fetch(gatewayRequest);
      return await handler(gatewayRequest);
    } catch {
      throw new SmokeFailure(
        "Request failed before receiving an HTTP response.",
      );
    }
  };

  const post = (
    path: string,
    body: Record<string, unknown>,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<Response> =>
    request(
      path,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      true,
      timeoutMs,
    );

  if (imageCountOnly) {
    const response = await post("/v1/images/generations", {
      model: IMAGE_MODEL,
      prompt: "A tiny blue circle on a plain white background",
      size: "512x512",
      response_format: "url",
      n: 2,
    });
    const body = await jsonValue(response);
    check(
      response.ok,
      `Image count check failed: ${responseStatusSummary(response, body)}.`,
    );
    check(
      hasExactImageUrlResults(body, 2),
      "Image count response must contain exactly two safe HTTP(S) URL results.",
    );
    console.log(`PASS image count generation (HTTP ${response.status})`);
    console.log("SMOKE_RESULT=PASS");
    return;
  }

  if (base64Only) {
    const response = await post("/v1/images/generations", {
      model: IMAGE_MODEL,
      prompt: "A tiny purple circle on a plain white background",
      size: "512x512",
      response_format: "b64_json",
    });
    const body = await jsonValue(response);
    check(
      response.ok,
      `Base64 image failed: ${responseStatusSummary(response, body)}.`,
    );
    check(
      firstImageValue(body, "b64_json").length > 100,
      "Base64 image is too short.",
    );
    console.log("PASS Base64 image generation");
    console.log("SMOKE_RESULT=PASS");
    return;
  }

  if (editOnly) {
    const sourceResponse = await post("/v1/images/generations", {
      model: IMAGE_MODEL,
      prompt: "A tiny blue square on a plain white background",
      size: "512x512",
      response_format: "url",
    });
    const sourceBody = await jsonValue(sourceResponse);
    check(
      sourceResponse.ok,
      `Edit source image failed: ${
        responseStatusSummary(sourceResponse, sourceBody)
      }.`,
    );
    const sourceUrl = firstImageValue(sourceBody, "url");
    const editResponse = await post("/v1/images/edits", {
      model: IMAGE_MODEL,
      prompt: "Change the blue square to green and preserve the composition",
      size: "512x512",
      image: [sourceUrl],
      response_format: "url",
    });
    const editBody = await jsonValue(editResponse);
    check(
      editResponse.ok,
      `Image edit failed: ${responseStatusSummary(editResponse, editBody)}.`,
    );
    firstImageValue(editBody, "url");
    console.log("PASS JSON URL image edit");
    console.log("SMOKE_RESULT=PASS");
    return;
  }

  if (contentOnlyId !== undefined) {
    check(contentOnlyId.length > 0, "The content-only video ID is empty.");
    const contentResponse = await request(
      `/v1/videos/${encodeURIComponent(contentOnlyId)}/content`,
    );
    check(
      contentResponse.status === 302,
      `Video content returned HTTP ${contentResponse.status}.`,
    );
    const location = contentResponse.headers.get("location");
    check(
      location !== null && /^https?:\/\//.test(location),
      "Video redirect URL is invalid.",
    );
    console.log("PASS video content redirect");
    console.log("SMOKE_RESULT=PASS");
    return;
  }

  const missingAuth = await request(
    "/v1/chat/completions",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: CHAT_MODEL,
        messages: [{ role: "user", content: "hello" }],
      }),
    },
    false,
  );
  check(
    missingAuth.status === 401,
    "Missing Authorization did not return 401.",
  );
  console.log("PASS authorization guard");

  if (!mediaOnly) {
    const chatResponse = await post("/v1/chat/completions", {
      model: CHAT_MODEL,
      messages: [{ role: "user", content: "Reply with exactly: ok" }],
      max_tokens: 8,
      chat_template_kwargs: { enable_thinking: false },
    }, CHAT_REQUEST_TIMEOUT_MS);
    const chat = await jsonValue(chatResponse);
    check(
      chatResponse.ok,
      `Chat failed: ${responseStatusSummary(chatResponse, chat)}.`,
    );
    check(
      isRecord(chat) && chat.model === CHAT_MODEL,
      "Chat response model changed.",
    );
    console.log("PASS non-streaming chat");

    const streamResponse = await post("/v1/chat/completions", {
      model: CHAT_MODEL,
      messages: [{ role: "user", content: "Reply with: ok" }],
      max_tokens: 8,
      chat_template_kwargs: { enable_thinking: false },
      stream: true,
    }, CHAT_REQUEST_TIMEOUT_MS);
    check(
      streamResponse.ok,
      `Streaming chat returned HTTP ${streamResponse.status}.`,
    );
    const stream = await streamResponse.text();
    check(
      stream.includes("data:"),
      "Streaming chat did not return SSE data events.",
    );
    check(stream.includes("[DONE]"), "Streaming chat did not return [DONE].");
    console.log("PASS streaming chat");
  }

  let imageUrl = PUBLIC_REFERENCE_IMAGE;
  if (!videoOnly) {
    const imageUrlResponse = await post("/v1/images/generations", {
      model: IMAGE_MODEL,
      prompt: "A simple blue glass sphere on a clean white studio background",
      size: "1024x768",
      response_format: "url",
      n: 2,
    });
    const imageUrlBody = await jsonValue(imageUrlResponse);
    check(
      imageUrlResponse.ok,
      `URL image failed: ${
        responseStatusSummary(imageUrlResponse, imageUrlBody)
      }.`,
    );
    check(
      hasExactImageUrlResults(imageUrlBody, 2),
      "URL image response must contain exactly two safe HTTP(S) results.",
    );
    imageUrl = firstImageValue(imageUrlBody, "url");
    console.log("PASS URL image count generation");

    if (!generatedVideoOnly) {
      const imageBase64Response = await post("/v1/images/generations", {
        model: IMAGE_MODEL,
        prompt: "A small red cube on a clean white studio background",
        size: "1024x768",
        response_format: "b64_json",
      });
      const imageBase64Body = await jsonValue(imageBase64Response);
      if (imageBase64Response.ok) {
        const data =
          isRecord(imageBase64Body) && Array.isArray(imageBase64Body.data)
            ? imageBase64Body.data
            : [];
        const first = data.length > 0 && isRecord(data[0])
          ? data[0]
          : undefined;
        const base64 = first?.b64_json;
        if (typeof base64 === "string" && base64.length > 100) {
          console.log("PASS Base64 image generation");
        } else {
          warnings++;
          console.log(
            "WARN Base64 image response omitted a usable b64_json value",
          );
        }
      } else {
        warnings++;
        console.log(
          `WARN Base64 image upstream failure: ${
            responseStatusSummary(imageBase64Response, imageBase64Body)
          }`,
        );
      }

      const imageEditResponse = await post("/v1/images/edits", {
        model: IMAGE_MODEL,
        prompt:
          "Change the glass sphere to green while preserving the composition",
        size: "1024x768",
        image: [imageUrl],
        response_format: "url",
      });
      const imageEditBody = await jsonValue(imageEditResponse);
      if (imageEditResponse.ok) {
        firstImageValue(imageEditBody, "url");
        console.log("PASS JSON URL image edit");
      } else {
        warnings++;
        console.log(
          `WARN image edit upstream failure: ${
            responseStatusSummary(imageEditResponse, imageEditBody)
          }`,
        );
      }
    }
  }

  const videoCreateResponse = await post("/v1/videos", {
    model: VIDEO_MODEL,
    prompt:
      "A slow cinematic camera push-in, gentle natural motion, stable composition",
    input_reference: { image_url: imageUrl },
    seconds: "4",
    size: "1280x720",
  });
  const videoCreate = await jsonValue(videoCreateResponse);
  check(
    videoCreateResponse.ok,
    `Video create failed: ${
      responseStatusSummary(videoCreateResponse, videoCreate)
    }.`,
  );
  check(isRecord(videoCreate), "Video create response must be an object.");
  check(
    typeof videoCreate.id === "string" && videoCreate.id.length > 0,
    "Video ID is missing.",
  );
  check(videoCreate.model === VIDEO_MODEL, "Video response model changed.");
  const videoId = videoCreate.id;
  console.log("PASS video create");

  const deadline = Date.now() + VIDEO_TIMEOUT_MS;
  let video = videoCreate;
  while (video.status === "queued" || video.status === "in_progress") {
    check(Date.now() < deadline, "Timed out waiting for video completion.");
    await new Promise((resolve) => setTimeout(resolve, VIDEO_POLL_INTERVAL_MS));
    const pollResponse = await request(
      `/v1/videos/${encodeURIComponent(videoId)}`,
    );
    const pollBody = await jsonValue(pollResponse);
    check(
      pollResponse.ok,
      `Video poll failed: ${responseStatusSummary(pollResponse, pollBody)}.`,
    );
    check(isRecord(pollBody), "Video poll response must be an object.");
    video = pollBody;
    const progress = typeof video.progress === "number"
      ? `${video.progress}%`
      : "unknown progress";
    console.log(`WAIT video ${video.status} (${progress})`);
  }
  check(
    video.status === "completed",
    "Video did not complete successfully.",
  );
  console.log("PASS video completion");

  const contentResponse = await request(
    `/v1/videos/${encodeURIComponent(videoId)}/content`,
  );
  check(
    contentResponse.status === 302,
    `Video content returned HTTP ${contentResponse.status}.`,
  );
  const location = contentResponse.headers.get("location");
  check(
    location !== null && /^https?:\/\//.test(location),
    "Video redirect URL is invalid.",
  );
  console.log("PASS video content redirect");

  const invalidAuthorizationResponse = await request(
    "/v1/chat/completions",
    {
      method: "POST",
      headers: {
        authorization: "Bearer gateway-smoke-invalid",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: CHAT_MODEL,
        messages: [{ role: "user", content: "Reply with: ok" }],
        max_tokens: 8,
      }),
    },
    false,
    CHAT_REQUEST_TIMEOUT_MS,
  );
  const invalidAuthorizationBody = await jsonValue(
    invalidAuthorizationResponse,
  );
  check(
    !invalidAuthorizationResponse.ok,
    `Invalid Authorization was accepted: ${
      responseStatusSummary(
        invalidAuthorizationResponse,
        invalidAuthorizationBody,
      )
    }.`,
  );
  check(
    hasOpenAIErrorEnvelope(invalidAuthorizationBody),
    "Invalid Authorization did not return an OpenAI error envelope.",
  );
  console.log(
    `PASS Agnes authentication error normalization (${
      responseStatusSummary(
        invalidAuthorizationResponse,
        invalidAuthorizationBody,
      )
    })`,
  );

  enforcePreviewWarnings(previewMode, warnings);

  console.log(
    warnings === 0 ? "SMOKE_RESULT=PASS" : "SMOKE_RESULT=PASS_WITH_WARNINGS",
  );
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    const message = error instanceof SmokeFailure
      ? error.message
      : "Unexpected smoke failure.";
    console.error(`SMOKE_RESULT=FAIL ${message}`);
    Deno.exitCode = 1;
  }
}
