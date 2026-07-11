import { createGatewayApp } from "../gateway/app.ts";
import { isRecord } from "../gateway/errors.ts";

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

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
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

function responseErrorMessage(value: unknown): string {
  if (isRecord(value) && isRecord(value.error)) {
    const message = value.error.message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return "unknown upstream error";
}

async function jsonValue(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `Expected JSON for HTTP ${response.status}, received ${
        text.slice(0, 160)
      }`,
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
  const base64Only = Deno.args.includes("--base64-only");
  const editOnly = Deno.args.includes("--edit-only");
  const contentOnlyArgument = Deno.args.find((value) =>
    value.startsWith("--content-id=")
  );
  const contentOnlyId = contentOnlyArgument?.slice("--content-id=".length);
  const videoOnly = Deno.args.includes("--video-only");
  const generatedVideoOnly = Deno.args.includes("--generated-video-only");
  const mediaOnly = Deno.args.includes("--media-only") || videoOnly ||
    generatedVideoOnly;
  const key = (await readSecretLine()).trim();
  check(key.length > 0, "No API key was provided on stdin.");
  const authorization = `Bearer ${key}`;
  const handler = createGatewayApp().handler();
  let warnings = 0;

  const request = (
    path: string,
    init: RequestInit = {},
    authenticated = true,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<Response> => {
    const headers = new Headers(init.headers);
    if (authenticated) headers.set("authorization", authorization);
    return handler(
      new Request(`${GATEWAY_ORIGIN}${path}`, {
        ...init,
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      }),
    );
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

  if (base64Only) {
    const response = await post("/v1/images/generations", {
      model: IMAGE_MODEL,
      prompt: "A tiny purple circle on a plain white background",
      size: "512x512",
      response_format: "b64_json",
    });
    const body = await jsonValue(response);
    check(response.ok, `Base64 image failed: ${responseErrorMessage(body)}`);
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
      `Edit source image failed: ${responseErrorMessage(sourceBody)}`,
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
      `Image edit failed: ${responseErrorMessage(editBody)}`,
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
    check(chatResponse.ok, `Chat failed: ${responseErrorMessage(chat)}`);
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
    });
    const imageUrlBody = await jsonValue(imageUrlResponse);
    check(
      imageUrlResponse.ok,
      `URL image failed: ${responseErrorMessage(imageUrlBody)}`,
    );
    imageUrl = firstImageValue(imageUrlBody, "url");
    console.log("PASS URL image generation");

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
          const fields = first === undefined
            ? "none"
            : Object.keys(first).sort().join(",");
          console.log(
            `WARN Base64 image response omitted b64_json; returned fields: ${fields}`,
          );
        }
      } else {
        warnings++;
        console.log(
          `WARN Base64 image upstream failure (HTTP ${imageBase64Response.status}): ${
            responseErrorMessage(imageBase64Body)
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
          `WARN image edit upstream failure (HTTP ${imageEditResponse.status}): ${
            responseErrorMessage(imageEditBody)
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
    `Video create failed: ${responseErrorMessage(videoCreate)}`,
  );
  check(isRecord(videoCreate), "Video create response must be an object.");
  check(
    typeof videoCreate.id === "string" && videoCreate.id.length > 0,
    "Video ID is missing.",
  );
  check(videoCreate.model === VIDEO_MODEL, "Video response model changed.");
  const videoId = videoCreate.id;
  console.log(`PASS video create (${videoId})`);

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
      `Video poll failed: ${responseErrorMessage(pollBody)}`,
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
    `Video ended with status ${String(video.status)}.`,
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

  const invalidModelResponse = await post("/v1/chat/completions", {
    model: "gateway-smoke-invalid-model",
    messages: [{ role: "user", content: "This request should fail." }],
    max_tokens: 8,
  }, CHAT_REQUEST_TIMEOUT_MS);
  const invalidModelBody = await jsonValue(invalidModelResponse);
  if (invalidModelResponse.ok) {
    console.log(
      "WARN Agnes accepted the intentionally invalid model; error smoke skipped",
    );
  } else {
    check(
      isRecord(invalidModelBody) && isRecord(invalidModelBody.error),
      "Invalid model did not return an OpenAI error envelope.",
    );
    console.log(
      `PASS Agnes error normalization (HTTP ${invalidModelResponse.status})`,
    );
  }

  console.log(
    warnings === 0
      ? "SMOKE_RESULT=PASS"
      : `SMOKE_RESULT=PASS_WITH_WARNINGS (${warnings})`,
  );
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error
    ? error.message
    : "unknown smoke failure";
  console.error(`SMOKE_RESULT=FAIL ${message}`);
  Deno.exitCode = 1;
}
