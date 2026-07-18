import {
  assertEquals,
  assertMatch,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.14";
import { joinBaseUrl, normalizeBaseUrl } from "../lib/config.ts";
import { createGateway } from "../lib/gateway.ts";
import type { FetchLike, JsonObject } from "../lib/types.ts";

const BASE_URL = "https://agnes.example/v1";
const API_KEY = "Bearer caller-owned-key";

Deno.test("configuration normalizes and joins the Agnes base URL", () => {
  assertEquals(
    normalizeBaseUrl(" https://agnes.example/custom/v1/// "),
    "https://agnes.example/custom/v1",
  );
  assertEquals(
    joinBaseUrl("https://agnes.example/custom/v1", "/chat/completions"),
    "https://agnes.example/custom/v1/chat/completions",
  );
  for (
    const unsafe of [
      "https://user:secret@agnes.example/v1",
      "https://agnes.example/v1?route=other",
      "https://agnes.example/v1?",
      "https://agnes.example/v1#fragment",
      "https://agnes.example/v1#",
    ]
  ) {
    let rejected = false;
    try {
      normalizeBaseUrl(unsafe);
    } catch {
      rejected = true;
    }
    assertEquals(rejected, true);
  }
});

Deno.test("chat maps developer and max_completion_tokens and reports ignored fields", async () => {
  let upstreamBody: JsonObject | undefined;
  const fetch: FetchLike = (input, init) => {
    assertEquals(String(input), `${BASE_URL}/chat/completions`);
    assertEquals(new Headers(init?.headers).get("authorization"), API_KEY);
    assertEquals(init?.redirect, "error");
    upstreamBody = JSON.parse(String(init?.body));
    return Promise.resolve(Response.json({
      id: "chatcmpl_1",
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" } }],
    }, { headers: { "x-request-id": "agnes-request-1" } }));
  };
  const gateway = createGateway({ agnesBaseUrl: `${BASE_URL}/`, fetch });
  const response = await gateway.handleChatCompletions(jsonRequest(
    "/v1/chat/completions",
    {
      model: "agnes-2.0-flash",
      messages: [{
        role: "developer",
        content: "Be concise",
        name: "policy-author",
        metadata: { private: "must-not-reach-Agnes" },
      }],
      max_tokens: "invalid-but-overridden",
      max_completion_tokens: 20,
      logit_bias: { "1": 1 },
    },
    { "x-request-id": "caller-request-1" },
  ));

  assertEquals(response.status, 200);
  assertEquals(response.headers.get("x-request-id"), "caller-request-1");
  assertEquals(response.headers.get("x-agnes-request-id"), "agnes-request-1");
  assertEquals(response.headers.get("access-control-allow-origin"), "*");
  assertEquals(
    response.headers.get("x-agnes-gateway-ignored-params"),
    "logit_bias,max_tokens,messages.0.metadata,messages.0.name",
  );
  assertEquals(upstreamBody, {
    model: "agnes-2.0-flash",
    messages: [{ role: "system", content: "Be concise" }],
    max_tokens: 20,
  });
});

Deno.test("chat message allowlist drops undocumented nested fields", async () => {
  let upstreamBody: JsonObject | undefined;
  const gateway = createGateway({
    agnesBaseUrl: BASE_URL,
    fetch: (_input, init) => {
      upstreamBody = JSON.parse(String(init?.body));
      return Promise.resolve(Response.json({ choices: [] }));
    },
  });
  const response = await gateway.handleChatCompletions(jsonRequest(
    "/v1/chat/completions",
    {
      model: "chat",
      messages: [{
        role: "assistant",
        content: "hello",
        tool_calls: [{ id: "call_secret", type: "function" }],
        refusal: "private refusal",
        audio: { id: "audio_secret" },
      }],
    },
  ));

  assertEquals(response.status, 200);
  assertEquals(upstreamBody?.messages, [{
    role: "assistant",
    content: "hello",
  }]);
  assertEquals(
    response.headers.get("x-agnes-gateway-ignored-params"),
    "messages.0.audio,messages.0.refusal,messages.0.tool_calls",
  );
});

Deno.test("ignored-parameter headers redact unsafe names and cap their size", async () => {
  const secretFieldName = "Bearer caller-owned-secret";
  const input: JsonObject = {
    model: "chat",
    messages: [{ role: "user", content: "hello" }],
    [secretFieldName]: true,
  };
  for (let index = 0; index < 40; index++) {
    input[`unsupported_${String(index).padStart(2, "0")}`] = index;
  }
  const gateway = createGateway({
    agnesBaseUrl: BASE_URL,
    fetch: () => Promise.resolve(Response.json({ choices: [] })),
  });
  const response = await gateway.handleChatCompletions(jsonRequest(
    "/v1/chat/completions",
    input,
  ));
  const ignored = response.headers.get(
    "x-agnes-gateway-ignored-params",
  ) ?? "";

  assertEquals(response.status, 200);
  assertEquals(ignored.includes(secretFieldName), false);
  assertStringIncludes(ignored, "<redacted>");
  assertStringIncludes(ignored, "<truncated>");
});

Deno.test("chat rejects undocumented tool-response messages", async () => {
  let calls = 0;
  const gateway = createGateway({
    agnesBaseUrl: BASE_URL,
    fetch: () => {
      calls += 1;
      return Promise.resolve(Response.json({}));
    },
  });
  const response = await gateway.handleChatCompletions(jsonRequest(
    "/v1/chat/completions",
    {
      model: "chat",
      messages: [{
        role: "tool",
        content: "result",
        tool_call_id: "call_1",
      }],
    },
  ));
  const payload = await response.json();

  assertEquals(response.status, 400);
  assertEquals(payload.error.param, "messages.0.role");
  assertEquals(
    response.headers.get("x-agnes-gateway-ignored-params"),
    "messages.0.tool_call_id",
  );
  assertEquals(calls, 0);
});

Deno.test("chat SSE is streamed byte-for-byte without buffering", async () => {
  const encoded = new TextEncoder().encode(
    'data: {"choices":[{"delta":{"content":"你好"}}]}\n\ndata: [DONE]\n\n',
  );
  let canceled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      // Split inside the multibyte UTF-8 text to prove the gateway does not
      // decode and re-encode SSE chunks.
      controller.enqueue(encoded.subarray(0, 42));
      controller.enqueue(encoded.subarray(42, 45));
      controller.enqueue(encoded.subarray(45));
      controller.close();
    },
    cancel() {
      canceled = true;
    },
  });
  const gateway = createGateway({
    agnesBaseUrl: BASE_URL,
    fetch: (_input, init) => {
      assertEquals(
        new Headers(init?.headers).get("accept"),
        "text/event-stream",
      );
      return Promise.resolve(
        new Response(body, {
          headers: { "content-type": "text/event-stream; charset=utf-8" },
        }),
      );
    },
  });
  const response = await gateway.handleChatCompletions(jsonRequest(
    "/v1/chat/completions",
    {
      model: "agnes-2.0-flash",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
      stream_options: { include_usage: true },
    },
  ));

  assertEquals(new Uint8Array(await response.arrayBuffer()), encoded);
  assertEquals(
    response.headers.get("content-type"),
    "text/event-stream; charset=utf-8",
  );
  assertEquals(
    response.headers.get("x-agnes-gateway-ignored-params"),
    "stream_options",
  );
  assertEquals(canceled, false);
});

Deno.test("canceling a Chat SSE response propagates to the Agnes stream", async () => {
  let canceled = false;
  const upstreamBody = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("data: {}\n\n"));
      // Intentionally leave the stream open until the downstream caller
      // disconnects. This mirrors a long-lived SSE response.
    },
    cancel() {
      canceled = true;
    },
  });
  const gateway = createGateway({
    agnesBaseUrl: BASE_URL,
    fetch: () =>
      Promise.resolve(
        new Response(upstreamBody, {
          headers: { "content-type": "text/event-stream" },
        }),
      ),
  });
  const response = await gateway.handleChatCompletions(jsonRequest(
    "/v1/chat/completions",
    {
      model: "agnes-2.0-flash",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    },
  ));

  await response.body?.cancel("test client disconnected");
  assertEquals(canceled, true);
});

Deno.test("an inbound abort after SSE headers does not cut off the stream", async () => {
  const inbound = new AbortController();
  let upstreamController: ReadableStreamDefaultController<Uint8Array>;
  const gateway = createGateway({
    agnesBaseUrl: BASE_URL,
    fetch: (_input, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          upstreamController = controller;
          init?.signal?.addEventListener("abort", () => {
            controller.error(new DOMException("Aborted", "AbortError"));
          }, { once: true });
        },
      });
      return Promise.resolve(
        new Response(body, {
          headers: { "content-type": "text/event-stream" },
        }),
      );
    },
  });
  const request = new Request(
    "https://gateway.example/v1/chat/completions",
    {
      method: "POST",
      headers: {
        authorization: API_KEY,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "chat",
        messages: [{ role: "user", content: "hello" }],
        stream: true,
      }),
      signal: inbound.signal,
    },
  );
  const response = await gateway.handleChatCompletions(request);

  inbound.abort("Fresh lifecycle completed");
  upstreamController!.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
  upstreamController!.close();
  assertEquals(await response.text(), "data: [DONE]\n\n");
});

Deno.test("chat filters unsupported content blocks and image detail", async () => {
  let body: JsonObject | undefined;
  const gateway = createGateway({
    agnesBaseUrl: BASE_URL,
    fetch: (_input, init) => {
      body = JSON.parse(String(init?.body));
      return Promise.resolve(Response.json({ choices: [] }));
    },
  });
  const response = await gateway.handleChatCompletions(jsonRequest(
    "/v1/chat/completions",
    {
      model: "chat",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "describe" },
          {
            type: "image_url",
            image_url: { url: "https://images.example/a.png", detail: "high" },
          },
          {
            type: "input_audio",
            input_audio: { data: "secret", format: "wav" },
          },
          { type: "file", file: { file_id: "file_1" } },
        ],
      }],
    },
  ));

  assertEquals(response.status, 200);
  assertEquals(body?.messages, [{
    role: "user",
    content: [
      { type: "text", text: "describe" },
      {
        type: "image_url",
        image_url: { url: "https://images.example/a.png" },
      },
    ],
  }]);
  assertEquals(
    response.headers.get("x-agnes-gateway-ignored-params"),
    "messages.0.content.1.image_url.detail,messages.0.content.2,messages.0.content.3",
  );
});

Deno.test("chat rejects a message emptied by unsupported content filtering", async () => {
  let calls = 0;
  const gateway = createGateway({
    agnesBaseUrl: BASE_URL,
    fetch: () => {
      calls += 1;
      return Promise.resolve(Response.json({}));
    },
  });
  const response = await gateway.handleChatCompletions(jsonRequest(
    "/v1/chat/completions",
    {
      model: "chat",
      messages: [{
        role: "user",
        content: [{ type: "input_audio", input_audio: { data: "x" } }],
      }],
    },
  ));
  const payload = await response.json();
  assertEquals(response.status, 400);
  assertEquals(payload.error.param, "messages.0.content");
  assertEquals(
    response.headers.get("x-agnes-gateway-ignored-params"),
    "messages.0.content.0",
  );
  assertEquals(calls, 0);
});

Deno.test("missing caller authorization returns an OpenAI authentication error", async () => {
  let called = false;
  const gateway = createGateway({
    agnesBaseUrl: BASE_URL,
    fetch: () => {
      called = true;
      return Promise.resolve(Response.json({}));
    },
  });
  const request = new Request("https://gateway.example/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "m",
      messages: [{ role: "user", content: "x" }],
    }),
  });
  const response = await gateway.handleChatCompletions(request);
  const payload = await response.json();

  assertEquals(called, false);
  assertEquals(response.status, 401);
  assertEquals(payload.error.type, "authentication_error");
  assertEquals(payload.error.code, "invalid_api_key");
});

Deno.test("upstream header waits time out with a normalized 504", async () => {
  const gateway = createGateway({
    agnesBaseUrl: BASE_URL,
    upstreamResponseHeaderTimeoutMs: 5,
    fetch: (_input, init) => rejectWhenAborted(init?.signal),
  });
  const response = await gateway.handleChatCompletions(chatRequest());
  const payload = await response.json();

  assertEquals(response.status, 504);
  assertEquals(payload.error.code, "upstream_timeout");
});

Deno.test("a client abort before upstream headers cancels the request", async () => {
  const started = Promise.withResolvers<void>();
  const controller = new AbortController();
  const gateway = createGateway({
    agnesBaseUrl: BASE_URL,
    upstreamResponseHeaderTimeoutMs: 1_000,
    fetch: (_input, init) => {
      started.resolve();
      return rejectWhenAborted(init?.signal);
    },
  });
  const request = new Request(
    "https://gateway.example/v1/chat/completions",
    {
      method: "POST",
      headers: {
        authorization: API_KEY,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "chat",
        messages: [{ role: "user", content: "hello" }],
      }),
      signal: controller.signal,
    },
  );
  const pending = gateway.handleChatCompletions(request);
  await started.promise;
  controller.abort("test client disconnected");
  const response = await pending;
  const payload = await response.json();

  assertEquals(response.status, 499);
  assertEquals(payload.error.code, "request_cancelled");
});

Deno.test("a client abort while buffering an image body returns 499", async () => {
  const bodyReadStarted = Promise.withResolvers<void>();
  const controller = new AbortController();
  let upstreamAborted = false;
  const gateway = createGateway({
    agnesBaseUrl: BASE_URL,
    fetch: (_input, init) => {
      let bodyController: ReadableStreamDefaultController<Uint8Array>;
      const never = new Promise<void>(() => {});
      const body = new ReadableStream<Uint8Array>({
        start(streamController) {
          bodyController = streamController;
          init?.signal?.addEventListener("abort", () => {
            upstreamAborted = true;
            bodyController.error(new DOMException("Aborted", "AbortError"));
          }, { once: true });
        },
        pull() {
          bodyReadStarted.resolve();
          return never;
        },
      });
      return Promise.resolve(new Response(body));
    },
  });
  const request = new Request(
    "https://gateway.example/v1/images/generations",
    {
      method: "POST",
      headers: {
        authorization: API_KEY,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "image", prompt: "hello" }),
      signal: controller.signal,
    },
  );

  const pending = gateway.handleImageGenerations(request);
  await bodyReadStarted.promise;
  controller.abort("test client disconnected");
  const response = await pending;
  const payload = await response.json();

  assertEquals(upstreamAborted, true);
  assertEquals(response.status, 499);
  assertEquals(payload.error.code, "request_cancelled");
});

Deno.test("structured Agnes errors preserve safe metadata but never reflect their body", async () => {
  const echoedKey = "caller-owned-key";
  const echoedDataUri = "data:image/png;base64,VERY_SECRET_IMAGE";
  const echoedPrompt = "confidential customer prompt";
  const gateway = createGateway({
    agnesBaseUrl: BASE_URL,
    fetch: () =>
      Promise.resolve(Response.json({
        error: {
          message:
            `Authorization: Bearer ${echoedKey}; ${echoedDataUri}; ${echoedPrompt}`,
        },
        message: `request body: ${echoedPrompt}`,
      }, {
        status: 429,
        headers: {
          "retry-after": "7",
          "x-request-id": "agnes-rate-1",
        },
      })),
  });
  const response = await gateway.handleChatCompletions(chatRequest());
  const payload = await response.json();

  assertEquals(response.status, 429);
  assertEquals(response.headers.get("retry-after"), "7");
  assertEquals(response.headers.get("x-agnes-request-id"), "agnes-rate-1");
  assertEquals(
    payload.error.message,
    "Agnes upstream request failed with status 429.",
  );
  assertEquals(payload.error.message.includes(echoedKey), false);
  assertEquals(payload.error.message.includes(echoedDataUri), false);
  assertEquals(payload.error.message.includes(echoedPrompt), false);
  assertEquals(payload.error.type, "rate_limit_error");
});

Deno.test("arbitrary upstream HTML is not reflected in public errors", async () => {
  const gateway = createGateway({
    agnesBaseUrl: BASE_URL,
    fetch: () =>
      Promise.resolve(
        new Response("<script>secret prompt</script>", {
          status: 502,
          headers: { "content-type": "text/html" },
        }),
      ),
  });
  const response = await gateway.handleChatCompletions(chatRequest());
  const payload = await response.json();
  assertEquals(response.status, 502);
  assertEquals(
    payload.error.message,
    "Agnes upstream request failed with status 502.",
  );
});

Deno.test("image n fans out concurrently and aggregates in request order", async () => {
  const upstreamBodies: JsonObject[] = [];
  let active = 0;
  let maximumActive = 0;
  const fetch: FetchLike = async (_input, init) => {
    const index = upstreamBodies.length;
    upstreamBodies.push(JSON.parse(String(init?.body)));
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    // Yield so all fan-out calls become active before any returns.
    await Promise.resolve();
    active -= 1;
    return Response.json({
      created: 100,
      data: [{ url: `https://images.example/${index}.png` }],
    });
  };
  const gateway = createGateway({ agnesBaseUrl: BASE_URL, fetch });
  const response = await gateway.handleImageGenerations(jsonRequest(
    "/v1/images/generations",
    {
      model: "agnes-image-2.1-flash",
      prompt: "city",
      n: 3,
      response_format: "b64_json",
      return_base64: false,
      extra_body: { response_format: "url" },
      image: "https://unsupported-top-level.example/input.png",
      quality: "high",
    },
  ));
  const payload = await response.json();

  assertEquals(response.status, 200);
  assertEquals(maximumActive, 3);
  assertEquals(payload.data, [
    { url: "https://images.example/0.png" },
    { url: "https://images.example/1.png" },
    { url: "https://images.example/2.png" },
  ]);
  assertEquals(upstreamBodies.length, 3);
  for (const body of upstreamBodies) {
    assertEquals(body, {
      model: "agnes-image-2.1-flash",
      prompt: "city",
      size: "1024x1024",
      extra_body: { response_format: "b64_json" },
    });
  }
  assertEquals(
    response.headers.get("x-agnes-gateway-ignored-params"),
    "extra_body.response_format,image,quality,return_base64",
  );
});

Deno.test("image response_format removes a conflicting Agnes return_base64 extension", async () => {
  let upstreamBody: JsonObject | undefined;
  const gateway = createGateway({
    agnesBaseUrl: BASE_URL,
    fetch: (_input, init) => {
      upstreamBody = JSON.parse(String(init?.body));
      return Promise.resolve(Response.json({ data: [{ url: "ok" }] }));
    },
  });
  const response = await gateway.handleImageGenerations(jsonRequest(
    "/v1/images/generations",
    {
      model: "image",
      prompt: "city",
      response_format: "url",
      // The OpenAI field wins without validating the discarded extension.
      return_base64: "invalid-but-overridden",
    },
  ));

  assertEquals(response.status, 200);
  assertEquals(upstreamBody, {
    model: "image",
    prompt: "city",
    size: "1024x1024",
    extra_body: { response_format: "url" },
  });
  assertEquals(
    response.headers.get("x-agnes-gateway-ignored-params"),
    "return_base64",
  );
});

Deno.test("one failed image fan-out makes the entire n request fail atomically", async () => {
  let calls = 0;
  const gateway = createGateway({
    agnesBaseUrl: BASE_URL,
    fetch: () => {
      const index = calls++;
      return Promise.resolve(
        index === 1
          ? Response.json({ error: { message: "busy" } }, {
            status: 429,
            headers: { "retry-after": "2" },
          })
          : Response.json({ data: [{ url: `https://images/${index}` }] }),
      );
    },
  });
  const response = await gateway.handleImageGenerations(jsonRequest(
    "/v1/images/generations",
    { model: "image", prompt: "x", n: 3 },
  ));
  const payload = await response.json();

  assertEquals(calls, 3);
  assertEquals(response.status, 429);
  assertEquals(response.headers.get("retry-after"), "2");
  assertEquals(
    payload.error.message,
    "Agnes upstream request failed with status 429.",
  );
  assertEquals(payload.data, undefined);
});

Deno.test("aggregated image responses honor the configured memory limit", async () => {
  const gateway = createGateway({
    agnesBaseUrl: BASE_URL,
    maxImageResponseBytes: 20,
    fetch: () =>
      Promise.resolve(Response.json({
        data: [{ b64_json: "abcdefghijklmnopqrstuvwxyz" }],
      })),
  });
  const response = await gateway.handleImageGenerations(jsonRequest(
    "/v1/images/generations",
    { model: "image", prompt: "x" },
  ));
  const payload = await response.json();
  assertEquals(response.status, 502);
  assertEquals(payload.error.code, "image_response_too_large");
});

Deno.test("an invalid image branch cancels unread fan-out bodies", async () => {
  let calls = 0;
  let unreadBranchCanceled = false;
  const unreadBody = new ReadableStream<Uint8Array>({
    cancel() {
      unreadBranchCanceled = true;
      throw new Error("simulated cancellation failure");
    },
  });
  const gateway = createGateway({
    agnesBaseUrl: BASE_URL,
    fetch: () => {
      calls += 1;
      return Promise.resolve(
        calls === 1 ? new Response("not-json") : new Response(unreadBody),
      );
    },
  });
  const response = await gateway.handleImageGenerations(jsonRequest(
    "/v1/images/generations",
    { model: "image", prompt: "x", n: 2 },
  ));
  const payload = await response.json();

  assertEquals(response.status, 502);
  assertEquals(payload.error.code, "invalid_upstream_response");
  assertEquals(unreadBranchCanceled, true);
});

Deno.test("multipart image edits convert files to Data URIs and support n", async () => {
  const calls: JsonObject[] = [];
  const gateway = createGateway({
    agnesBaseUrl: BASE_URL,
    fetch: (_input, init) => {
      calls.push(JSON.parse(String(init?.body)));
      return Promise.resolve(Response.json({ data: [{ b64_json: "result" }] }));
    },
  });
  const form = new FormData();
  form.set("model", "agnes-image-2.1-flash");
  form.set("prompt", "repaint");
  form.set("n", "2");
  form.set("response_format", "b64_json");
  form.set("return_base64", "invalid-but-overridden");
  form.set("quality", "high");
  form.append(
    "image",
    new File([new Uint8Array([1, 2, 3])], "one.png", {
      type: "image/png",
    }),
  );
  form.append(
    "image[]",
    new File([new Uint8Array([4, 5])], "two.webp", {
      type: "image/webp",
    }),
  );
  form.set(
    "mask",
    new File([new Uint8Array([9])], "mask.png", {
      type: "image/png",
    }),
  );

  const response = await gateway.handleImageEdits(formRequest(
    "/v1/images/edits",
    form,
  ));
  const payload = await response.json();

  assertEquals(response.status, 200);
  assertEquals(payload.data.length, 2);
  assertEquals(calls.length, 2);
  assertEquals(calls[0].extra_body, {
    image: [
      "data:image/png;base64,AQID",
      "data:image/webp;base64,BAU=",
    ],
    response_format: "b64_json",
  });
  assertEquals(calls[0].n, undefined);
  assertEquals(
    response.headers.get("x-agnes-gateway-ignored-params"),
    "mask,quality,return_base64",
  );
});

Deno.test("multipart image edits accept Agnes extra_body.image alone", async () => {
  let body: JsonObject | undefined;
  const gateway = createGateway({
    agnesBaseUrl: BASE_URL,
    fetch: (_input, init) => {
      body = JSON.parse(String(init?.body));
      return Promise.resolve(Response.json({ data: [{ url: "ok" }] }));
    },
  });
  const form = new FormData();
  form.set("model", "image");
  form.set("prompt", "edit");
  form.set(
    "extra_body",
    JSON.stringify({
      image: ["https://input.example/extension.png"],
      response_format: "url",
    }),
  );

  const response = await gateway.handleImageEdits(formRequest(
    "/v1/images/edits",
    form,
  ));
  assertEquals(response.status, 200);
  assertEquals(body?.extra_body, {
    image: ["https://input.example/extension.png"],
    response_format: "url",
  });
});

Deno.test("JSON image edits accept the images array and standard fields win", async () => {
  let body: JsonObject | undefined;
  const gateway = createGateway({
    agnesBaseUrl: BASE_URL,
    fetch: (_input, init) => {
      body = JSON.parse(String(init?.body));
      return Promise.resolve(Response.json({ data: [{ url: "ok" }] }));
    },
  });
  const response = await gateway.handleImageEdits(jsonRequest(
    "/v1/images/edits",
    {
      model: "image",
      prompt: "edit",
      images: [
        {
          image_url: {
            url: "https://input.example/a.png",
            detail: "high",
          },
          file_id: "file_also_ignored",
          metadata: "not-supported",
        },
        { file_id: "file_only_ignored" },
      ],
      image: "https://singular.example/also-loses.png",
      response_format: "url",
      extra_body: {
        image: ["https://extension.example/loses.png"],
        response_format: "b64_json",
      },
    },
  ));

  assertEquals(response.status, 200);
  assertEquals(body?.extra_body, {
    image: ["https://input.example/a.png"],
    response_format: "url",
  });
  assertEquals(
    response.headers.get("x-agnes-gateway-ignored-params"),
    "extra_body.image,extra_body.response_format,image,images.0.file_id,images.0.image_url.detail,images.0.metadata,images.1.file_id",
  );
});

Deno.test("multipart per-file limits return a normalized 413", async () => {
  const gateway = createGateway({
    agnesBaseUrl: BASE_URL,
    maxFileBytes: 2,
    fetch: () => Promise.resolve(Response.json({})),
  });
  const form = new FormData();
  form.set("model", "image");
  form.set("prompt", "x");
  form.set(
    "image",
    new File([new Uint8Array([1, 2, 3])], "big.png", {
      type: "image/png",
    }),
  );
  const response = await gateway.handleImageEdits(formRequest(
    "/v1/images/edits",
    form,
  ));
  const payload = await response.json();
  assertEquals(response.status, 413);
  assertEquals(payload.error.code, "file_too_large");
});

Deno.test("multipart file-count limits are enforced before an upstream call", async () => {
  let calls = 0;
  const gateway = createGateway({
    agnesBaseUrl: BASE_URL,
    maxImageFiles: 2,
    fetch: () => {
      calls += 1;
      return Promise.resolve(Response.json({}));
    },
  });
  const form = new FormData();
  form.set("model", "image");
  form.set("prompt", "x");
  for (let index = 0; index < 3; index++) {
    form.append(
      "image[]",
      new File([new Uint8Array([index])], `${index}.png`, {
        type: "image/png",
      }),
    );
  }

  const response = await gateway.handleImageEdits(formRequest(
    "/v1/images/edits",
    form,
  ));
  const payload = await response.json();
  assertEquals(response.status, 413);
  assertEquals(payload.error.code, "too_many_files");
  assertEquals(calls, 0);
});

Deno.test("video JSON maps seconds and size while retaining Agnes extensions", async () => {
  let body: JsonObject | undefined;
  const gateway = createGateway({
    agnesBaseUrl: BASE_URL,
    fetch: (input, init) => {
      assertEquals(String(input), `${BASE_URL}/videos`);
      body = JSON.parse(String(init?.body));
      return Promise.resolve(Response.json({
        id: "video_not_used_for_polling",
        task_id: "task_1",
        video_id: "video_1",
        status: "queued",
      }, { status: 201 }));
    },
  });
  const response = await gateway.handleVideoGeneration(jsonRequest(
    "/v1/videos",
    {
      model: "agnes-video-v2.0",
      prompt: "ocean",
      seconds: "8",
      size: "1280x720",
      width: 999,
      frame_rate: 30,
      "input_reference[image_url]": "https://json-bracket.invalid/image.png",
      seed: 42,
      negative_prompt: "blur",
      unknown_option: true,
    },
  ));
  const payload = await response.json();

  assertEquals(response.status, 201);
  assertEquals(payload.id, "task_1");
  assertEquals(body, {
    model: "agnes-video-v2.0",
    prompt: "ocean",
    num_frames: 193,
    frame_rate: 24,
    width: 1280,
    height: 720,
    seed: 42,
    negative_prompt: "blur",
  });
  assertEquals(
    response.headers.get("x-agnes-gateway-ignored-params"),
    "frame_rate,input_reference[image_url],unknown_option,width",
  );
});

Deno.test("video multipart input_reference is converted and overrides Agnes image", async () => {
  let body: JsonObject | undefined;
  const gateway = createGateway({
    agnesBaseUrl: BASE_URL,
    fetch: (_input, init) => {
      body = JSON.parse(String(init?.body));
      return Promise.resolve(Response.json({ id: "task_2", status: "queued" }));
    },
  });
  const form = new FormData();
  form.set("model", "agnes-video-v2.0");
  form.set("prompt", "animate");
  form.set("seconds", "4");
  form.set("size", "720x1280");
  form.set("image", "https://extension.example/loses.png");
  form.set("width", "invalid-but-overridden");
  form.set("frame_rate", "invalid-but-overridden");
  form.set(
    "input_reference",
    new File([new Uint8Array([7, 8])], "input.png", {
      type: "image/png",
    }),
  );
  const response = await gateway.handleVideoGeneration(formRequest(
    "/v1/videos",
    form,
  ));

  assertEquals(response.status, 200);
  assertEquals(body?.image, "data:image/png;base64,Bwg=");
  assertEquals(body?.num_frames, 97);
  assertEquals(
    response.headers.get("x-agnes-gateway-ignored-params"),
    "frame_rate,image,width",
  );
});

Deno.test("video accepts the official SDK's bracketed multipart reference", async () => {
  let body: JsonObject | undefined;
  const gateway = createGateway({
    agnesBaseUrl: BASE_URL,
    fetch: (_input, init) => {
      body = JSON.parse(String(init?.body));
      return Promise.resolve(
        Response.json({ id: "task_sdk", status: "queued" }),
      );
    },
  });
  const form = new FormData();
  form.set("model", "video");
  form.set("prompt", "animate");
  form.set("seconds", "4");
  form.set("size", "720x1280");
  form.set("input_reference[image_url]", "https://images.example/sdk.png");
  form.set("input_reference[file_id]", "file_not_resolvable");
  const response = await gateway.handleVideoGeneration(formRequest(
    "/v1/videos",
    form,
  ));

  assertEquals(response.status, 200);
  assertEquals(body?.image, "https://images.example/sdk.png");
  assertEquals(
    response.headers.get("x-agnes-gateway-ignored-params"),
    "input_reference.file_id",
  );
});

Deno.test("video JSON reference objects use image_url and report file_id", async () => {
  let body: JsonObject | undefined;
  const gateway = createGateway({
    agnesBaseUrl: BASE_URL,
    fetch: (_input, init) => {
      body = JSON.parse(String(init?.body));
      return Promise.resolve(
        Response.json({ id: "task_ref", status: "queued" }),
      );
    },
  });
  const response = await gateway.handleVideoGeneration(jsonRequest(
    "/v1/videos",
    {
      model: "video",
      prompt: "animate",
      input_reference: {
        image_url: {
          url: "data:image/png;base64,AQID",
          detail: "high",
        },
        file_id: "file_unavailable",
        metadata: "not-supported",
      },
    },
  ));
  assertEquals(response.status, 200);
  assertEquals(body?.image, "data:image/png;base64,AQID");
  assertEquals(
    response.headers.get("x-agnes-gateway-ignored-params"),
    "input_reference.file_id,input_reference.image_url.detail,input_reference.metadata",
  );
});

Deno.test("video retrieval uses the legacy stateless Agnes task path", async () => {
  const fetch: FetchLike = (input, init) => {
    assertEquals(String(input), `${BASE_URL}/videos/task%2Fwith%20space`);
    assertEquals(new Headers(init?.headers).get("authorization"), API_KEY);
    return Promise.resolve(Response.json({
      video_id: "video_123",
      status: "completed",
      url: "https://media.example/video.mp4",
    }));
  };
  const gateway = createGateway({ agnesBaseUrl: BASE_URL, fetch });
  const response = await gateway.handleVideoRetrieval(
    getRequest("/v1/videos/task%2Fwith%20space"),
    "task/with space",
  );
  const payload = await response.json();
  assertEquals(response.status, 200);
  assertEquals(payload.id, "video_123");
  assertEquals(payload.video_id, "video_123");
});

Deno.test("video content resolves metadata then proxies a Range without the API key", async () => {
  let calls = 0;
  const bytes = new Uint8Array([10, 11, 12]);
  const fetch: FetchLike = (input, init) => {
    calls += 1;
    if (calls === 1) {
      assertEquals(String(input), `${BASE_URL}/videos/task_3`);
      assertEquals(new Headers(init?.headers).get("authorization"), API_KEY);
      return Promise.resolve(Response.json({
        id: "task_3",
        status: "completed",
        url: "https://media.example/video.mp4",
      }));
    }
    assertEquals(String(input), "https://media.example/video.mp4");
    const headers = new Headers(init?.headers);
    assertEquals(headers.get("authorization"), null);
    assertEquals(headers.get("range"), "bytes=10-12");
    return Promise.resolve(
      new Response(Uint8Array.from(bytes).buffer, {
        status: 206,
        headers: {
          "content-type": "video/mp4",
          "content-range": "bytes 10-12/100",
          "accept-ranges": "bytes",
          "content-length": "3",
          "cache-control": "public, max-age=86400",
        },
      }),
    );
  };
  const gateway = createGateway({ agnesBaseUrl: BASE_URL, fetch });
  const request = getRequest(
    "/v1/videos/task_3/content?variant=thumbnail",
    { range: "bytes=10-12" },
  );
  const response = await gateway.handleVideoContent(request, "task_3");

  assertEquals(response.status, 206);
  assertEquals(new Uint8Array(await response.arrayBuffer()), bytes);
  assertEquals(response.headers.get("content-range"), "bytes 10-12/100");
  assertEquals(response.headers.get("accept-ranges"), "bytes");
  assertEquals(response.headers.get("cache-control"), "private, no-store");
  assertEquals(response.headers.get("vary"), "Origin, Authorization, Range");
  assertEquals(
    response.headers.get("x-agnes-gateway-ignored-params"),
    "variant",
  );
  assertEquals(calls, 2);
});

Deno.test("video content returns a normalized conflict while a task is pending", async () => {
  const gateway = createGateway({
    agnesBaseUrl: BASE_URL,
    fetch: () =>
      Promise.resolve(Response.json({ id: "task", status: "in_progress" })),
  });
  const response = await gateway.handleVideoContent(
    getRequest("/v1/videos/task/content"),
    "task",
  );
  const payload = await response.json();
  assertEquals(response.status, 409);
  assertEquals(payload.error.code, "video_not_ready");
  assertEquals(payload.error.param, "video_id");
});

Deno.test("request body and validation failures use OpenAI errors without upstream calls", async () => {
  let calls = 0;
  const gateway = createGateway({
    agnesBaseUrl: BASE_URL,
    maxRequestBytes: 20,
    fetch: () => {
      calls += 1;
      return Promise.resolve(Response.json({}));
    },
  });
  const response = await gateway.handleChatCompletions(jsonRequest(
    "/v1/chat/completions",
    { model: "model-with-a-long-name", messages: [] },
  ));
  const payload = await response.json();
  assertEquals(response.status, 413);
  assertEquals(payload.error.code, "request_too_large");
  assertEquals(calls, 0);
});

Deno.test("preflight is public and exposes compatibility headers", () => {
  const gateway = createGateway({ agnesBaseUrl: BASE_URL });
  const response = gateway.handleOptions();
  assertEquals(response.status, 204);
  assertStringIncludes(
    response.headers.get("access-control-allow-headers") ?? "",
    "Authorization",
  );
  assertStringIncludes(
    response.headers.get("access-control-expose-headers") ?? "",
    "X-Agnes-Gateway-Ignored-Params",
  );
  assertEquals(response.headers.get("access-control-allow-credentials"), null);
});

Deno.test("invalid content type and video duration are rejected locally", async () => {
  let calls = 0;
  const gateway = createGateway({
    agnesBaseUrl: BASE_URL,
    fetch: () => {
      calls += 1;
      return Promise.resolve(Response.json({}));
    },
  });
  const wrongType = await gateway.handleChatCompletions(
    new Request(
      "https://gateway.example/v1/chat/completions",
      { method: "POST", headers: { authorization: API_KEY }, body: "{}" },
    ),
  );
  assertEquals(wrongType.status, 415);

  const tooLong = await gateway.handleVideoGeneration(jsonRequest(
    "/v1/videos",
    { model: "video", prompt: "x", seconds: 19 },
  ));
  const payload = await tooLong.json();
  assertEquals(tooLong.status, 400);
  assertEquals(payload.error.param, "seconds");
  assertMatch(payload.error.message, /4, 8, or 12/);
  assertEquals(calls, 0);
});

function jsonRequest(
  path: string,
  body: unknown,
  headers: HeadersInit = {},
): Request {
  const combined = new Headers(headers);
  combined.set("authorization", combined.get("authorization") ?? API_KEY);
  combined.set("content-type", "application/json");
  return new Request(`https://gateway.example${path}`, {
    method: "POST",
    headers: combined,
    body: JSON.stringify(body),
  });
}

function chatRequest(): Request {
  return jsonRequest("/v1/chat/completions", {
    model: "agnes-2.0-flash",
    messages: [{ role: "user", content: "hello" }],
  });
}

function rejectWhenAborted(
  signal: AbortSignal | null | undefined,
): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const abort = () => reject(new DOMException("Aborted", "AbortError"));
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

function formRequest(path: string, form: FormData): Request {
  return new Request(`https://gateway.example${path}`, {
    method: "POST",
    headers: { authorization: API_KEY },
    body: form,
  });
}

function getRequest(path: string, headers: HeadersInit = {}): Request {
  const combined = new Headers(headers);
  combined.set("authorization", API_KEY);
  return new Request(`https://gateway.example${path}`, { headers: combined });
}
