import { assertEquals, assertObjectMatch } from "@std/assert";
import OpenAI from "openai";
import { createGatewayApp } from "../gateway/app.ts";

const AGNES_BASE_URL = "https://agnes-sdk.test/v1";

function upstreamJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

Deno.test("OpenAI JavaScript SDK calls the supported chat, image, and video subset", async () => {
  const upstreamCalls: Request[] = [];
  let imageSequence = 0;
  const upstreamFetch = ((
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const request = new Request(input, init);
    upstreamCalls.push(request.clone());
    const path = new URL(request.url).pathname;

    if (path.endsWith("/chat/completions")) {
      return Promise.resolve(upstreamJson({
        id: "chatcmpl_sdk",
        object: "chat.completion",
        created: 1,
        model: "agnes-chat-response",
        choices: [{
          index: 0,
          message: { role: "assistant", content: "SDK works" },
          finish_reason: "stop",
        }],
      }));
    }
    if (path.endsWith("/images/generations")) {
      imageSequence++;
      return Promise.resolve(upstreamJson({
        created: 2,
        data: [{ url: `https://images.test/sdk-${imageSequence}.png` }],
      }));
    }
    if (path.endsWith("/videos")) {
      return Promise.resolve(upstreamJson({
        video_id: "video_sdk",
        model: "agnes-video-response",
        status: "queued",
        progress: 0,
        seconds: "4.0",
        size: "1280x720",
        created_at: 3,
      }));
    }
    return Promise.reject(new Error(`Unexpected Agnes path: ${path}`));
  }) as typeof fetch;

  const gatewayHandler = createGatewayApp({
    agnesBaseUrl: AGNES_BASE_URL,
    fetch: upstreamFetch,
  }).handler();
  const gatewayFetch =
    ((input: RequestInfo | URL, init?: RequestInit) =>
      gatewayHandler(new Request(input, init))) as typeof fetch;
  const client = new OpenAI({
    apiKey: "sdk-user-key",
    adminAPIKey: null,
    baseURL: "https://gateway-sdk.test/v1",
    fetch: gatewayFetch,
    logLevel: "off",
    maxRetries: 0,
    organization: null,
    project: null,
    webhookSecret: null,
  });

  const chat = await client.chat.completions.create({
    model: "agnes-chat-request",
    messages: [{ role: "user", content: "hello" }],
  });
  assertEquals(chat.model, "agnes-chat-response");
  assertEquals(chat.choices[0].message.content, "SDK works");

  const image = await client.images.generate({
    model: "agnes-image-request",
    prompt: "a test image",
    size: "1024x1024",
    response_format: "url",
    n: 2,
  });
  assertEquals(image.data?.map((item) => item.url), [
    "https://images.test/sdk-1.png",
    "https://images.test/sdk-2.png",
  ]);

  const video = await client.videos.create({
    model: "agnes-video-request",
    prompt: "a test video",
    seconds: "4",
    size: "1280x720",
    input_reference: { image_url: "https://images.test/sdk-input.png" },
  });
  assertEquals(video.id, "video_sdk");
  assertEquals(video.model, "agnes-video-response");

  assertEquals(upstreamCalls.length, 4);
  for (const request of upstreamCalls) {
    assertEquals(request.headers.get("authorization"), "Bearer sdk-user-key");
    assertEquals(request.headers.get("content-type"), "application/json");
  }
  for (const request of upstreamCalls.slice(1, 3)) {
    assertObjectMatch(await request.json(), {
      model: "agnes-image-request",
      prompt: "a test image",
      size: "1024x1024",
      extra_body: { response_format: "url" },
    });
  }
  assertObjectMatch(await upstreamCalls[3].json(), {
    model: "agnes-video-request",
    prompt: "a test video",
    frame_rate: 24,
    num_frames: 97,
    width: 1280,
    height: 720,
    image: "https://images.test/sdk-input.png",
  });
});
