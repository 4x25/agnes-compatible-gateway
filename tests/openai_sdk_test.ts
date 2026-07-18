import OpenAI, { toFile } from "openai";
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "jsr:@std/assert@^1.0.14";
import { createGateway } from "../lib/gateway.ts";

/**
 * Exercise the public wire format through the official TypeScript SDK.
 *
 * Core tests call handlers directly for exhaustive edge coverage; this test
 * adds the serialization layer that commonly breaks compatibility (notably
 * multipart image/video uploads and the video content response).
 */
Deno.test("official OpenAI TypeScript SDK can use every gateway workflow", async () => {
  const upstreamBodies: unknown[] = [];
  let imageNumber = 0;
  let mediaRequestHadAuthorization = false;

  const gateway = createGateway({
    agnesBaseUrl: "https://agnes.test/v1",
    fetch: (input, init) => {
      const url = new URL(
        input instanceof Request ? input.url : input.toString(),
      );
      const headers = new Headers(
        input instanceof Request ? input.headers : init?.headers,
      );

      if (url.hostname === "media.test") {
        mediaRequestHadAuthorization = headers.has("authorization");
        return Promise.resolve(
          new Response(new Uint8Array([0, 1, 2, 3]), {
            headers: { "content-type": "video/mp4" },
          }),
        );
      }

      assertEquals(headers.get("authorization"), "Bearer sdk-test-key");
      if (init?.body && typeof init.body === "string") {
        upstreamBodies.push(JSON.parse(init.body));
      }

      if (url.pathname.endsWith("/chat/completions")) {
        return Promise.resolve(Response.json({
          id: "chatcmpl_sdk",
          object: "chat.completion",
          created: 1,
          model: "agnes-2.0-flash",
          choices: [{
            index: 0,
            message: { role: "assistant", content: "SDK connected" },
            finish_reason: "stop",
          }],
          usage: {
            prompt_tokens: 1,
            completion_tokens: 2,
            total_tokens: 3,
          },
        }));
      }
      if (url.pathname.endsWith("/images/generations")) {
        imageNumber += 1;
        return Promise.resolve(Response.json({
          created: 1,
          data: [{ url: `https://images.test/${imageNumber}.png` }],
        }));
      }
      if (url.pathname.endsWith("/videos") && init?.method === "POST") {
        return Promise.resolve(Response.json({
          id: "task_sdk",
          task_id: "task_sdk",
          video_id: "video_sdk",
          object: "video",
          model: "agnes-video-v2.0",
          status: "queued",
          progress: 0,
          created_at: 1,
          seconds: "4",
          size: "720x1280",
        }));
      }
      if (
        url.pathname.endsWith("/agnesapi") &&
        url.searchParams.get("video_id") === "video_sdk"
      ) {
        return Promise.resolve(Response.json({
          id: "task_sdk",
          video_id: "video_sdk",
          object: "video",
          model: "agnes-video-v2.0",
          status: "completed",
          progress: 100,
          seconds: "4",
          size: "720x1280",
          url: "https://media.test/video.mp4",
          error: null,
        }));
      }
      return Promise.resolve(
        new Response("unexpected fake upstream request", { status: 500 }),
      );
    },
  });

  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen() {},
  }, (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/v1/chat/completions") {
      return gateway.handleChatCompletions(request);
    }
    if (url.pathname === "/v1/images/generations") {
      return gateway.handleImageGenerations(request);
    }
    if (url.pathname === "/v1/images/edits") {
      return gateway.handleImageEdits(request);
    }
    if (url.pathname === "/v1/videos" && request.method === "POST") {
      return gateway.handleVideoGeneration(request);
    }
    const content = /^\/v1\/videos\/([^/]+)\/content$/.exec(url.pathname);
    if (content) return gateway.handleVideoContent(request, content[1]);
    const video = /^\/v1\/videos\/([^/]+)$/.exec(url.pathname);
    if (video) return gateway.handleVideoRetrieval(request, video[1]);
    return new Response("not found", { status: 404 });
  });

  try {
    const address = server.addr as Deno.NetAddr;
    // OpenAI's multipart feature probe otherwise calls `fetch("data:,")` and
    // inspects only the response constructor. Deno 2.5 correctly reports that
    // probe response as an unconsumed body. Supplying the standard
    // `fetch.Response` capability expected by the SDK avoids the disposable
    // request without weakening leak sanitization or changing HTTP behavior.
    const sdkFetch = Object.assign(globalThis.fetch.bind(globalThis), {
      Response,
    });
    const client = new OpenAI({
      apiKey: "sdk-test-key",
      baseURL: `http://127.0.0.1:${address.port}/v1`,
      maxRetries: 0,
      fetch: sdkFetch,
    });

    const chat = await client.chat.completions.create({
      model: "agnes-2.0-flash",
      messages: [{ role: "user", content: "Hello" }],
    });
    assertEquals(chat.choices[0]?.message.content, "SDK connected");

    const generated = await client.images.generate({
      model: "agnes-image-2.1-flash",
      prompt: "An orange square",
      n: 2,
      size: "1024x1024",
    });
    assertEquals(generated.data?.length, 2);

    const imageFile = await toFile(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      "reference.png",
      { type: "image/png" },
    );
    const edited = await client.images.edit({
      model: "agnes-image-2.1-flash",
      image: imageFile,
      prompt: "Make it orange",
      size: "1024x1024",
    });
    assertStringIncludes(edited.data?.[0]?.url ?? "", "images.test");

    const videoFile = await toFile(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      "video-reference.png",
      { type: "image/png" },
    );
    const created = await client.videos.create({
      model: "agnes-video-v2.0",
      prompt: "Slow camera push",
      input_reference: videoFile,
      seconds: "4",
      size: "720x1280",
    });
    assertEquals(created.id, "video_sdk");

    const retrieved = await client.videos.retrieve(created.id);
    assertEquals(retrieved.status, "completed");
    const contentResponse = await client.videos.downloadContent(created.id);
    assertEquals(
      [...new Uint8Array(await contentResponse.arrayBuffer())],
      [0, 1, 2, 3],
    );
    assert(!mediaRequestHadAuthorization);

    const videoBody = upstreamBodies.find((body) =>
      typeof body === "object" && body !== null &&
      (body as Record<string, unknown>).model === "agnes-video-v2.0"
    ) as Record<string, unknown>;
    assertStringIncludes(String(videoBody.image), "data:image/png;base64,");
  } finally {
    await server.shutdown();
  }
});
