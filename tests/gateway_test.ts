import {
  assert,
  assertEquals,
  assertMatch,
  assertObjectMatch,
} from "@std/assert";
import { createGatewayApp } from "../gateway/app.ts";
import {
  IMAGE_EDIT_REQUEST_BODY_LIMIT_BYTES,
  STANDARD_REQUEST_BODY_LIMIT_BYTES,
} from "../gateway/transforms.ts";

const GATEWAY_ORIGIN = "https://gateway.test";
const AGNES_BASE_URL = "https://agnes.test/proxy/v1/";
const AUTHORIZATION = "Bearer user-secret";

type Responder = (request: Request) => Response | Promise<Response>;

interface TestGateway {
  calls: Request[];
  request(path: string, init?: RequestInit): Promise<Response>;
}

function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  const outputHeaders = new Headers(headers);
  outputHeaders.set("content-type", "application/json");
  return new Response(JSON.stringify(body), { status, headers: outputHeaders });
}

function createTestGateway(responder: Responder): TestGateway {
  const calls: Request[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    calls.push(request.clone());
    return await responder(request);
  }) as typeof fetch;
  const handler = createGatewayApp({
    agnesBaseUrl: AGNES_BASE_URL,
    fetch: fetcher,
    now: () => 1_750_000_000_000,
  }).handler();

  return {
    calls,
    request(path: string, init?: RequestInit): Promise<Response> {
      return handler(new Request(`${GATEWAY_ORIGIN}${path}`, init));
    },
  };
}

function postJson(body: unknown, authorization = AUTHORIZATION): RequestInit {
  return {
    method: "POST",
    headers: {
      authorization,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  };
}

async function responseJson(
  response: Response,
): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

Deno.test("every endpoint rejects a missing Authorization header before upstream", async () => {
  const gateway = createTestGateway(() => {
    throw new Error("upstream must not be called");
  });
  const requests: Array<[string, RequestInit]> = [
    ["/v1/chat/completions", postJson({}, "")],
    ["/v1/images/generations", postJson({}, "")],
    ["/v1/images/edits", postJson({}, "")],
    ["/v1/videos", postJson({}, "")],
    ["/v1/videos/video_123", { method: "GET" }],
    ["/v1/videos/video_123/content", { method: "GET" }],
  ];

  for (const [path, init] of requests) {
    const response = await gateway.request(path, init);
    assertEquals(response.status, 401, path);
    assertObjectMatch(await responseJson(response), {
      error: { code: "invalid_api_key", param: null },
    });
  }
  assertEquals(gateway.calls.length, 0);
});

Deno.test("POST endpoints validate their required fields", async () => {
  const gateway = createTestGateway(() => json({ ok: true }));
  const cases: Array<[string, unknown, string]> = [
    ["/v1/chat/completions", { messages: [{}] }, "model"],
    ["/v1/chat/completions", { model: "m" }, "messages"],
    ["/v1/images/generations", { prompt: "p", size: "1x1" }, "model"],
    ["/v1/images/generations", { model: "m", size: "1x1" }, "prompt"],
    [
      "/v1/images/edits",
      { model: "m", prompt: "p", size: "1x1" },
      "image",
    ],
    [
      "/v1/images/edits",
      { model: "m", prompt: "p", image: "https://images.test/in.png" },
      "size",
    ],
    ["/v1/videos", { prompt: "p" }, "model"],
    ["/v1/videos", { model: "m" }, "prompt"],
  ];

  for (const [path, body, param] of cases) {
    const response = await gateway.request(path, postJson(body));
    assertEquals(response.status, 400, `${path}:${param}`);
    assertObjectMatch(await responseJson(response), { error: { param } });
  }
  assertEquals(gateway.calls.length, 0);
});

Deno.test("malformed bodies, unsupported media, unknown routes, and empty IDs use OpenAI errors", async () => {
  const gateway = createTestGateway(() => json({ ok: true }));

  const malformed = await gateway.request("/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: AUTHORIZATION,
      "content-type": "application/json",
    },
    body: "{",
  });
  assertEquals(malformed.status, 400);
  assertObjectMatch(await responseJson(malformed), {
    error: { code: "invalid_json" },
  });

  const media = await gateway.request("/v1/images/edits", {
    method: "POST",
    headers: {
      authorization: AUTHORIZATION,
      "content-type": "multipart/form-data; boundary=nope",
    },
    body: "--nope--",
  });
  assertEquals(media.status, 415);
  assertObjectMatch(await responseJson(media), {
    error: { code: "unsupported_media_type" },
  });

  const unknown = await gateway.request("/v1/responses", {
    method: "POST",
    headers: { authorization: AUTHORIZATION },
  });
  assertEquals(unknown.status, 404);
  assertObjectMatch(await responseJson(unknown), {
    error: { code: "not_found" },
  });

  const emptyVideoId = await gateway.request("/v1/videos/", {
    method: "GET",
    headers: { authorization: AUTHORIZATION },
  });
  assertEquals(emptyVideoId.status, 400);
  assertObjectMatch(await responseJson(emptyVideoId), {
    error: { param: "video_id" },
  });
  assertEquals(gateway.calls.length, 0);
});

Deno.test("request body limits reject declared and streamed oversized bodies before upstream", async (t) => {
  await t.step("declared ordinary JSON size", async () => {
    const gateway = createTestGateway(() => {
      throw new Error("upstream must not be called");
    });
    const response = await gateway.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: AUTHORIZATION,
        "content-type": "application/json",
        "content-length": String(STANDARD_REQUEST_BODY_LIMIT_BYTES + 1),
      },
      body: "{}",
    });

    assertEquals(response.status, 413);
    assertObjectMatch(await responseJson(response), {
      error: { code: "request_too_large", type: "invalid_request_error" },
    });
    assertEquals(gateway.calls.length, 0);
  });

  await t.step("streamed ordinary JSON size", async () => {
    const gateway = createTestGateway(() => {
      throw new Error("upstream must not be called");
    });
    let remaining = STANDARD_REQUEST_BODY_LIMIT_BYTES + 1;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const size = Math.min(256 * 1024, remaining);
        controller.enqueue(new Uint8Array(size));
        remaining -= size;
        if (remaining === 0) controller.close();
      },
    });
    const response = await gateway.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: AUTHORIZATION,
        "content-type": "application/json",
      },
      body,
    });

    assertEquals(response.status, 413);
    assertObjectMatch(await responseJson(response), {
      error: { code: "request_too_large" },
    });
    assertEquals(gateway.calls.length, 0);
  });

  await t.step("multipart video size", async () => {
    const gateway = createTestGateway(() => {
      throw new Error("upstream must not be called");
    });
    const form = new FormData();
    form.set("model", "m");
    form.set("prompt", "x".repeat(STANDARD_REQUEST_BODY_LIMIT_BYTES));
    const response = await gateway.request("/v1/videos", {
      method: "POST",
      headers: { authorization: AUTHORIZATION },
      body: form,
    });

    assertEquals(response.status, 413);
    assertObjectMatch(await responseJson(response), {
      error: { code: "request_too_large" },
    });
    assertEquals(gateway.calls.length, 0);
  });

  await t.step("declared image edit size", async () => {
    const gateway = createTestGateway(() => {
      throw new Error("upstream must not be called");
    });
    const response = await gateway.request("/v1/images/edits", {
      method: "POST",
      headers: {
        authorization: AUTHORIZATION,
        "content-type": "application/json",
        "content-length": String(IMAGE_EDIT_REQUEST_BODY_LIMIT_BYTES + 1),
      },
      body: "{}",
    });

    assertEquals(response.status, 413);
    assertObjectMatch(await responseJson(response), {
      error: { code: "request_too_large" },
    });
    assertEquals(gateway.calls.length, 0);
  });
});

Deno.test("JSON image edits use the larger body limit for Data URIs", async () => {
  const gateway = createTestGateway(() => json({ created: 1, data: [] }));
  const response = await gateway.request(
    "/v1/images/edits",
    postJson({
      model: "m",
      prompt: "p",
      size: "1x1",
      image: `data:image/png;base64,${
        "A".repeat(STANDARD_REQUEST_BODY_LIMIT_BYTES)
      }`,
    }),
  );

  assertEquals(response.status, 200);
  assertEquals(gateway.calls.length, 1);
});

Deno.test("chat completion filters fields, maps max_completion_tokens, and preserves response", async () => {
  const upstreamBody = {
    id: "chatcmpl_123",
    object: "chat.completion",
    model: "agnes-returned-model",
    choices: [{ index: 0, message: { role: "assistant", content: "ok" } }],
    usage: { total_tokens: 3 },
  };
  const gateway = createTestGateway(() =>
    json(upstreamBody, 200, { "x-request-id": "req_123" })
  );
  const messages = [{ role: "user", content: "hello" }];

  const response = await gateway.request(
    "/v1/chat/completions",
    postJson({
      model: "user-model",
      messages,
      temperature: 0.4,
      top_p: 0.9,
      max_completion_tokens: 321,
      stream: false,
      tools: [{ type: "function", function: { name: "lookup" } }],
      tool_choice: "auto",
      chat_template_kwargs: { enable_thinking: true },
      user: "ignored",
      unknown: "ignored",
    }),
  );

  assertEquals(response.status, 200);
  assertEquals(response.headers.get("x-request-id"), "req_123");
  assertEquals(await response.json(), upstreamBody);
  assertEquals(gateway.calls.length, 1);
  assertEquals(gateway.calls[0].url, `${AGNES_BASE_URL}chat/completions`);
  assertEquals(gateway.calls[0].headers.get("authorization"), AUTHORIZATION);
  assertEquals(await gateway.calls[0].json(), {
    model: "user-model",
    messages,
    temperature: 0.4,
    top_p: 0.9,
    max_tokens: 321,
    stream: false,
    tools: [{ type: "function", function: { name: "lookup" } }],
    tool_choice: "auto",
    chat_template_kwargs: { enable_thinking: true },
  });
});

Deno.test("chat max_tokens takes precedence over max_completion_tokens", async () => {
  const gateway = createTestGateway(() => json({ model: "m" }));
  await gateway.request(
    "/v1/chat/completions",
    postJson({
      model: "m",
      messages: [{ role: "user", content: "x" }],
      max_tokens: 10,
      max_completion_tokens: 20,
    }),
  );
  assertObjectMatch(await gateway.calls[0].json(), { max_tokens: 10 });
});

Deno.test("chat streaming forwards SSE chunks without buffering", async () => {
  const encoder = new TextEncoder();
  const chunks = [
    'data: {"id":"one","model":"upstream-model"}\n\n',
    "data: [DONE]\n\n",
  ];
  let accept: string | null = null;
  const gateway = createTestGateway((request) => {
    accept = request.headers.get("accept");
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    return new Response(body, {
      headers: { "content-type": "text/event-stream; charset=utf-8" },
    });
  });

  const response = await gateway.request(
    "/v1/chat/completions",
    postJson({
      model: "stream-model",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
      stream_options: { include_usage: true },
    }),
  );
  assertEquals(response.status, 200);
  assertEquals(accept, "text/event-stream");
  assertMatch(
    response.headers.get("content-type") ?? "",
    /^text\/event-stream/,
  );
  assertEquals(response.headers.get("cache-control"), "no-cache");

  const reader = response.body?.getReader();
  assert(reader !== undefined);
  const decoder = new TextDecoder();
  const received: string[] = [];
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    received.push(decoder.decode(result.value));
  }
  assertEquals(received, chunks);
});

Deno.test("image generation maps URL and Base64 formats", async () => {
  const gateway = createTestGateway(() =>
    json({ created: 1, data: [{ url: "https://images.test/out.png" }] })
  );

  const urlResponse = await gateway.request(
    "/v1/images/generations",
    postJson({
      model: "custom-image-model",
      prompt: "a lighthouse",
      size: "1024x768",
      quality: "high",
    }),
  );
  assertEquals(urlResponse.status, 200);
  assertEquals(await gateway.calls[0].json(), {
    model: "custom-image-model",
    prompt: "a lighthouse",
    size: "1024x768",
    extra_body: { response_format: "url" },
  });

  await gateway.request(
    "/v1/images/generations",
    postJson({
      model: "custom-image-model",
      prompt: "a lighthouse",
      size: "1024x768",
      response_format: "b64_json",
    }),
  );
  assertEquals(await gateway.calls[1].json(), {
    model: "custom-image-model",
    prompt: "a lighthouse",
    size: "1024x768",
    return_base64: true,
    extra_body: { response_format: "b64_json" },
  });
});

Deno.test("image generation normalizes omitted, null, and exact auto sizes", async () => {
  let sequence = 0;
  const gateway = createTestGateway(() =>
    json({
      created: ++sequence,
      data: [{ url: `https://images.test/out-${sequence}.png` }],
    })
  );
  const cases: Array<
    [Record<string, unknown>, string, number]
  > = [
    [{}, "2048x2048", 1],
    [{ size: null }, "2048x2048", 1],
    [{ size: "auto", n: 2 }, "2048x2048", 2],
    [{ size: "AUTO" }, "AUTO", 1],
    [{ size: " auto " }, " auto ", 1],
  ];

  for (const [extra, expectedSize, expectedCalls] of cases) {
    const callsBefore = gateway.calls.length;
    const response = await gateway.request(
      "/v1/images/generations",
      postJson({ model: "m", prompt: "p", ...extra }),
    );
    assertEquals(response.status, 200);
    assertEquals(gateway.calls.length - callsBefore, expectedCalls);
    for (const request of gateway.calls.slice(callsBefore)) {
      assertEquals(await request.json(), {
        model: "m",
        prompt: "p",
        size: expectedSize,
        extra_body: { response_format: "url" },
      });
    }
  }
});

Deno.test("image generation rejects invalid size values", async () => {
  const gateway = createTestGateway(() => {
    throw new Error("upstream must not be called");
  });
  const invalidSizes: unknown[] = ["", " ", 2048, true, [], {}];

  for (const size of invalidSizes) {
    const response = await gateway.request(
      "/v1/images/generations",
      postJson({ model: "m", prompt: "p", size }),
    );
    assertEquals(response.status, 400, JSON.stringify(size));
    assertObjectMatch(await responseJson(response), {
      error: {
        type: "invalid_request_error",
        param: "size",
        code: "invalid_parameter",
      },
    });
  }
  assertEquals(gateway.calls.length, 0);
});

Deno.test("n=1 keeps the single-call image response passthrough", async () => {
  const exactBody =
    '{"created":1,"data":[{"url":"https://images.test/out.png"}]}';
  const gateway = createTestGateway(() =>
    new Response(exactBody, {
      status: 201,
      headers: {
        "content-type": "application/vnd.agnes-image+json",
        "x-request-id": "single-request",
      },
    })
  );

  const response = await gateway.request(
    "/v1/images/generations",
    postJson({ model: "m", prompt: "p", size: "1x1", n: 1 }),
  );

  assertEquals(response.status, 201);
  assertEquals(
    response.headers.get("content-type"),
    "application/vnd.agnes-image+json",
  );
  assertEquals(response.headers.get("x-request-id"), "single-request");
  assertEquals(await response.text(), exactBody);
  assertEquals(gateway.calls.length, 1);
  assertEquals(await gateway.calls[0].json(), {
    model: "m",
    prompt: "p",
    size: "1x1",
    extra_body: { response_format: "url" },
  });
});

Deno.test("image generation fans out sequentially and aggregates URL results", async () => {
  let sequence = 0;
  const gateway = createTestGateway(() => {
    sequence++;
    return json(
      {
        created: 100 + sequence,
        data: [{ url: `https://images.test/out-${sequence}.png` }],
      },
      200,
      {
        "x-request-id": `request-${sequence}`,
        "x-ratelimit-remaining-images": String(10 - sequence),
      },
    );
  });

  const response = await gateway.request(
    "/v1/images/generations",
    postJson({
      model: "unlisted-image-model",
      prompt: "a lighthouse",
      size: "1024x768",
      n: 4,
      quality: "high",
    }),
  );

  assertEquals(response.status, 200);
  assertEquals(await responseJson(response), {
    created: 101,
    data: [
      { url: "https://images.test/out-1.png" },
      { url: "https://images.test/out-2.png" },
      { url: "https://images.test/out-3.png" },
      { url: "https://images.test/out-4.png" },
    ],
  });
  assertEquals(response.headers.get("x-request-id"), "request-4");
  assertEquals(response.headers.get("x-ratelimit-remaining-images"), "6");
  assertEquals(gateway.calls.length, 4);
  for (const request of gateway.calls) {
    assertEquals(await request.json(), {
      model: "unlisted-image-model",
      prompt: "a lighthouse",
      size: "1024x768",
      extra_body: { response_format: "url" },
    });
  }
});

Deno.test("image generation does not start the next fan-out call early", async () => {
  const firstResponse = Promise.withResolvers<Response>();
  const firstStarted = Promise.withResolvers<void>();
  let sequence = 0;
  const gateway = createTestGateway(() => {
    sequence++;
    if (sequence === 1) {
      firstStarted.resolve();
      return firstResponse.promise;
    }
    return json({
      created: 2,
      data: [{ url: "https://images.test/two.png" }],
    });
  });

  const pending = gateway.request(
    "/v1/images/generations",
    postJson({ model: "m", prompt: "p", size: "1x1", n: 2 }),
  );
  await firstStarted.promise;
  assertEquals(gateway.calls.length, 1);

  firstResponse.resolve(
    json({
      created: 1,
      data: [{ url: "https://images.test/one.png" }],
    }),
  );
  const response = await pending;
  assertEquals(response.status, 200);
  assertEquals(gateway.calls.length, 2);
});

Deno.test("image generation fans out Base64 results with the Agnes flags", async () => {
  let sequence = 0;
  const gateway = createTestGateway(() => {
    sequence++;
    return json({
      created: sequence,
      data: [{ b64_json: `encoded-${sequence}`, revised_prompt: null }],
    });
  });

  const response = await gateway.request(
    "/v1/images/generations",
    postJson({
      model: "m",
      prompt: "p",
      size: "1x1",
      response_format: "b64_json",
      n: 2,
    }),
  );

  assertEquals(await responseJson(response), {
    created: 1,
    data: [
      { b64_json: "encoded-1", revised_prompt: null },
      { b64_json: "encoded-2", revised_prompt: null },
    ],
  });
  assertEquals(gateway.calls.length, 2);
  for (const request of gateway.calls) {
    assertEquals(await request.json(), {
      model: "m",
      prompt: "p",
      size: "1x1",
      return_base64: true,
      extra_body: { response_format: "b64_json" },
    });
  }
});

Deno.test("image generation accepts count boundaries and treats null as omitted", async () => {
  let sequence = 0;
  const gateway = createTestGateway(() =>
    json({
      created: ++sequence,
      data: [{ url: `https://images.test/out-${sequence}.png` }],
    })
  );
  const cases: Array<[Record<string, unknown>, number]> = [
    [{ n: 1 }, 1],
    [{ n: 10 }, 10],
    [{}, 1],
    [{ n: null }, 1],
  ];

  for (const [extra, expectedCalls] of cases) {
    const callsBefore = gateway.calls.length;
    const response = await gateway.request(
      "/v1/images/generations",
      postJson({ model: "m", prompt: "p", size: "1x1", ...extra }),
    );
    assertEquals(response.status, 200);
    assertEquals(gateway.calls.length - callsBefore, expectedCalls);
    const body = await responseJson(response);
    assertEquals((body.data as unknown[]).length, expectedCalls);
  }
  assertEquals(gateway.calls.length, 13);
  for (const request of gateway.calls) {
    const body = await request.json() as Record<string, unknown>;
    assertEquals(body.n, undefined);
  }
});

Deno.test("image generation rejects invalid counts before calling Agnes", async () => {
  const gateway = createTestGateway(() => {
    throw new Error("upstream must not be called");
  });
  const invalidCounts: unknown[] = ["2", true, 1.5, 0, 11];

  for (const n of invalidCounts) {
    const response = await gateway.request(
      "/v1/images/generations",
      postJson({ model: "m", prompt: "p", size: "1x1", n }),
    );
    assertEquals(response.status, 400, JSON.stringify(n));
    assertObjectMatch(await responseJson(response), {
      error: {
        type: "invalid_request_error",
        param: "n",
        code: "invalid_parameter",
      },
    });
  }
  assertEquals(gateway.calls.length, 0);
});

Deno.test("image generation fan-out fails fast without returning partial results", async (t) => {
  await t.step("Agnes error", async () => {
    let sequence = 0;
    const gateway = createTestGateway(() => {
      sequence++;
      if (sequence === 1) {
        return json({
          created: 1,
          data: [{ url: "https://images.test/one.png" }],
        });
      }
      return json(
        { error: { message: "Rate limit reached", code: "rate_limited" } },
        429,
        { "retry-after": "9" },
      );
    });

    const response = await gateway.request(
      "/v1/images/generations",
      postJson({ model: "m", prompt: "p", size: "1x1", n: 3 }),
    );
    assertEquals(response.status, 429);
    assertEquals(response.headers.get("retry-after"), "9");
    assertObjectMatch(await responseJson(response), {
      error: { message: "Rate limit reached", code: "rate_limited" },
    });
    assertEquals(gateway.calls.length, 2);
  });

  await t.step("network error", async () => {
    let sequence = 0;
    const gateway = createTestGateway(() => {
      sequence++;
      if (sequence === 1) {
        return json({
          created: 1,
          data: [{ url: "https://images.test/one.png" }],
        });
      }
      throw new TypeError("network details");
    });

    const response = await gateway.request(
      "/v1/images/generations",
      postJson({ model: "m", prompt: "p", size: "1x1", n: 3 }),
    );
    assertEquals(response.status, 502);
    assertObjectMatch(await responseJson(response), {
      error: { code: "upstream_connection_error" },
    });
    assertEquals(gateway.calls.length, 2);
  });

  await t.step("malformed second success", async () => {
    let sequence = 0;
    const gateway = createTestGateway(() => {
      sequence++;
      return sequence === 1
        ? json({
          created: 1,
          data: [{ url: "https://images.test/one.png" }],
        })
        : json(
          { created: 2, data: [] },
          200,
          { "x-request-id": "malformed-second" },
        );
    });

    const response = await gateway.request(
      "/v1/images/generations",
      postJson({ model: "m", prompt: "p", size: "1x1", n: 3 }),
    );
    assertEquals(response.status, 502);
    assertEquals(response.headers.get("x-request-id"), "malformed-second");
    assertObjectMatch(await responseJson(response), {
      error: { code: "invalid_upstream_response" },
    });
    assertEquals(gateway.calls.length, 2);
  });
});

Deno.test("image generation fan-out rejects malformed single-image successes", async () => {
  const malformedBodies: unknown[] = [
    { data: [{ url: "https://images.test/out.png" }] },
    { created: -1, data: [{ url: "https://images.test/out.png" }] },
    { created: 1.5, data: [{ url: "https://images.test/out.png" }] },
    { created: 1, data: [] },
    { created: 1, data: [{ url: "one" }, { url: "two" }] },
    { created: 1, data: ["not-an-object"] },
    { created: 1, data: [{}] },
    { created: 1, data: [{ url: "" }] },
    { created: 1, data: [{ b64_json: "wrong-output-format" }] },
  ];

  for (const body of malformedBodies) {
    const gateway = createTestGateway(() =>
      json(body, 200, {
        "set-cookie": "secret=value",
        "x-request-id": "malformed-image",
      })
    );
    const response = await gateway.request(
      "/v1/images/generations",
      postJson({ model: "m", prompt: "p", size: "1x1", n: 2 }),
    );
    assertEquals(response.status, 502, JSON.stringify(body));
    assertObjectMatch(await responseJson(response), {
      error: { code: "invalid_upstream_response" },
    });
    assertEquals(response.headers.get("x-request-id"), "malformed-image");
    assertEquals(response.headers.get("set-cookie"), null);
    assertEquals(gateway.calls.length, 1);
  }

  const invalidJsonGateway = createTestGateway(() =>
    new Response("not json", {
      headers: {
        "content-type": "text/plain",
        "x-ratelimit-remaining-images": "3",
      },
    })
  );
  const invalidJsonResponse = await invalidJsonGateway.request(
    "/v1/images/generations",
    postJson({ model: "m", prompt: "p", size: "1x1", n: 2 }),
  );
  assertEquals(invalidJsonResponse.status, 502);
  assertEquals(
    invalidJsonResponse.headers.get("x-ratelimit-remaining-images"),
    "3",
  );

  const wrongBase64Gateway = createTestGateway(() =>
    json({
      created: 1,
      data: [{ url: "https://images.test/wrong-format.png" }],
    })
  );
  const wrongBase64Response = await wrongBase64Gateway.request(
    "/v1/images/generations",
    postJson({
      model: "m",
      prompt: "p",
      size: "1x1",
      response_format: "b64_json",
      n: 2,
    }),
  );
  assertEquals(wrongBase64Response.status, 502);
  assertEquals(wrongBase64Gateway.calls.length, 1);
});

Deno.test("client cancellation stops image fan-out before the next call", async () => {
  const controller = new AbortController();
  const gateway = createTestGateway(() => {
    controller.abort();
    return json({ created: 1, data: [{ url: "https://images.test/one.png" }] });
  });

  const response = await gateway.request(
    "/v1/images/generations",
    {
      ...postJson({ model: "m", prompt: "p", size: "1x1", n: 3 }),
      signal: controller.signal,
    },
  );
  assertEquals(response.status, 499);
  assertObjectMatch(await responseJson(response), {
    error: { code: "client_aborted" },
  });
  assertEquals(gateway.calls.length, 1);
});

Deno.test("client cancellation while reading an Agnes error stops image fan-out", async () => {
  const controller = new AbortController();
  const gateway = createTestGateway(() =>
    new Response(
      new ReadableStream({
        pull(streamController) {
          controller.abort();
          streamController.error(new DOMException("cancelled", "AbortError"));
        },
      }),
      { status: 429, headers: { "content-type": "application/json" } },
    )
  );

  const response = await gateway.request(
    "/v1/images/generations",
    {
      ...postJson({ model: "m", prompt: "p", size: "1x1", n: 2 }),
      signal: controller.signal,
    },
  );
  assertEquals(response.status, 499);
  assertObjectMatch(await responseJson(response), {
    error: { code: "client_aborted", type: "api_connection_error" },
  });
  assertEquals(gateway.calls.length, 1);
});

Deno.test("client cancellation while reading the second success stops image fan-out", async () => {
  const controller = new AbortController();
  let sequence = 0;
  const gateway = createTestGateway(() => {
    sequence++;
    if (sequence === 1) {
      return json({
        created: 1,
        data: [{ url: "https://images.test/one.png" }],
      });
    }
    return new Response(
      new ReadableStream({
        pull(streamController) {
          controller.abort();
          streamController.error(new DOMException("cancelled", "AbortError"));
        },
      }),
      {
        headers: { "content-type": "application/json" },
      },
    );
  });

  const response = await gateway.request(
    "/v1/images/generations",
    {
      ...postJson({ model: "m", prompt: "p", size: "1x1", n: 3 }),
      signal: controller.signal,
    },
  );
  assertEquals(response.status, 499);
  assertObjectMatch(await responseJson(response), {
    error: { code: "client_aborted", type: "api_connection_error" },
  });
  assertEquals(gateway.calls.length, 2);
});

Deno.test("image edits normalize URL and Data URI inputs into Agnes extra_body", async () => {
  const gateway = createTestGateway(() =>
    json({ created: 2, data: [{ b64_json: "encoded" }] })
  );
  const dataUri = "data:image/png;base64,aGVsbG8=";
  const response = await gateway.request(
    "/v1/images/edits",
    postJson({
      model: "edit-model",
      prompt: "make it orange",
      size: "1024x1024",
      image: ["https://images.test/in.png", dataUri],
      response_format: "b64_json",
      mask: "ignored",
    }),
  );

  assertEquals(response.status, 200);
  assertEquals(gateway.calls[0].url, `${AGNES_BASE_URL}images/generations`);
  assertEquals(await gateway.calls[0].json(), {
    model: "edit-model",
    prompt: "make it orange",
    size: "1024x1024",
    extra_body: {
      image: ["https://images.test/in.png", dataUri],
      response_format: "b64_json",
    },
  });

  await gateway.request(
    "/v1/images/edits",
    postJson({
      model: "edit-model",
      prompt: "edit",
      size: "512x512",
      image: "https://images.test/single.png",
    }),
  );
  assertObjectMatch(await gateway.calls[1].json(), {
    extra_body: {
      image: ["https://images.test/single.png"],
      response_format: "url",
    },
  });

  await gateway.request(
    "/v1/images/edits",
    postJson({
      model: "edit-model",
      prompt: "edit",
      size: "auto",
      image: "https://images.test/single.png",
    }),
  );
  assertObjectMatch(await gateway.calls[2].json(), {
    size: "auto",
    extra_body: {
      image: ["https://images.test/single.png"],
      response_format: "url",
    },
  });
});

Deno.test("image edits reject unsupported or credential-bearing image references", async () => {
  const gateway = createTestGateway(() => {
    throw new Error("upstream must not be called");
  });
  const invalidReferences: unknown[] = [
    "not-a-url",
    "ftp://images.test/in.png",
    "https://user:secret@images.test/in.png",
    "https://@images.test/in.png",
    "data:text/plain;base64,aGVsbG8=",
    ["https://images.test/valid.png", "javascript:alert(1)"],
  ];

  for (const image of invalidReferences) {
    const response = await gateway.request(
      "/v1/images/edits",
      postJson({ model: "m", prompt: "p", size: "1x1", image }),
    );
    assertEquals(response.status, 400, JSON.stringify(image));
    assertObjectMatch(await responseJson(response), {
      error: { code: "invalid_parameter", param: "image" },
    });
  }
  assertEquals(gateway.calls.length, 0);
});

Deno.test("JSON video creation maps OpenAI fields and returns video_id as id", async () => {
  const gateway = createTestGateway(() =>
    json({
      id: "task_internal",
      task_id: "task_internal",
      video_id: "video_public",
      object: "video",
      model: "agnes-returned-video-model",
      status: "queued",
      progress: 0,
      created_at: 1_780_000_000,
      seconds: "4.0",
      size: "1280x720",
    })
  );
  const response = await gateway.request(
    "/v1/videos",
    postJson({
      model: "user-video-model",
      prompt: "animate this image",
      input_reference: { image_url: "https://images.test/start.png" },
      seconds: "4",
      size: "1280x720",
      negative_prompt: "ignored",
    }),
  );

  assertEquals(await gateway.calls[0].json(), {
    model: "user-video-model",
    prompt: "animate this image",
    frame_rate: 24,
    num_frames: 97,
    width: 1280,
    height: 720,
    image: "https://images.test/start.png",
  });
  assertEquals(await response.json(), {
    id: "video_public",
    object: "video",
    model: "agnes-returned-video-model",
    status: "queued",
    prompt: "animate this image",
    progress: 0,
    size: "1280x720",
    seconds: "4.0",
    created_at: 1_780_000_000,
  });
});

Deno.test("multipart video creation accepts OpenAI SDK bracket notation", async () => {
  const gateway = createTestGateway(() =>
    json({
      video_id: "video_form",
      model: "form-model",
      status: "queued",
    })
  );
  const form = new FormData();
  form.set("model", "form-model");
  form.set("prompt", "form prompt");
  form.set("seconds", "8");
  form.set("size", "720x1280");
  form.set("input_reference[image_url]", "https://images.test/form.png");

  const response = await gateway.request("/v1/videos", {
    method: "POST",
    headers: { authorization: AUTHORIZATION },
    body: form,
  });
  assertEquals(response.status, 200);
  assertEquals(await gateway.calls[0].json(), {
    model: "form-model",
    prompt: "form prompt",
    frame_rate: 24,
    num_frames: 193,
    width: 720,
    height: 1280,
    image: "https://images.test/form.png",
  });
});

Deno.test("multipart video creation accepts a JSON input_reference field", async () => {
  const gateway = createTestGateway(() =>
    json({ video_id: "video_form", model: "m", status: "queued" })
  );
  const form = new FormData();
  form.set("model", "m");
  form.set("prompt", "p");
  form.set(
    "input_reference",
    JSON.stringify({ image_url: "https://images.test/reference.png" }),
  );
  await gateway.request("/v1/videos", {
    method: "POST",
    headers: { authorization: AUTHORIZATION },
    body: form,
  });
  assertObjectMatch(await gateway.calls[0].json(), {
    image: "https://images.test/reference.png",
  });
});

Deno.test("video creation ignores unsupported fields and unsafe references", async () => {
  const gateway = createTestGateway(() =>
    json({ video_id: "video_ignored", model: "m", status: "queued" })
  );
  await gateway.request(
    "/v1/videos",
    postJson({
      model: "m",
      prompt: "p",
      seconds: "5",
      size: "auto",
      input_reference: { image_url: "data:image/png;base64,AAAA" },
    }),
  );
  assertEquals(await gateway.calls[0].json(), { model: "m", prompt: "p" });

  await gateway.request(
    "/v1/videos",
    postJson({
      model: "m",
      prompt: "p",
      input_reference: {
        image_url: "https://user:secret@images.test/start.png",
      },
    }),
  );
  assertEquals(await gateway.calls[1].json(), { model: "m", prompt: "p" });
});

Deno.test("video creation rejects malformed successful Agnes responses", async () => {
  const gateway = createTestGateway(() =>
    json({ task_id: "task_only", model: "m", status: "queued" })
  );
  const response = await gateway.request(
    "/v1/videos",
    postJson({ model: "m", prompt: "p" }),
  );
  assertEquals(response.status, 502);
  assertObjectMatch(await responseJson(response), {
    error: { code: "invalid_upstream_response" },
  });
});

Deno.test("video status queries /agnesapi and returns the OpenAI video subset", async () => {
  let upstreamAuthorization: string | null = null;
  const gateway = createTestGateway((request) => {
    upstreamAuthorization = request.headers.get("authorization");
    return json(
      {
        id: "task_hidden",
        video_id: "video/a b",
        model: "upstream-video-model",
        object: "video",
        status: "completed",
        progress: 100,
        seconds: "8.0",
        size: "720x1280",
        url: "https://storage.test/video.mp4",
        error: null,
      },
      200,
      { "x-request-id": "video_req" },
    );
  });
  const response = await gateway.request("/v1/videos/video%2Fa%20b", {
    method: "GET",
    headers: { authorization: "Bearer another-user" },
  });

  assertEquals(
    gateway.calls[0].url,
    "https://agnes.test/proxy/agnesapi?video_id=video%2Fa+b",
  );
  assertEquals(upstreamAuthorization, "Bearer another-user");
  assertEquals(response.headers.get("x-request-id"), "video_req");
  assertEquals(await response.json(), {
    id: "video/a b",
    object: "video",
    model: "upstream-video-model",
    status: "completed",
    progress: 100,
    size: "720x1280",
    seconds: "8.0",
    error: null,
  });
});

Deno.test("video content redirects only completed videos with an HTTP(S) URL", async (t) => {
  await t.step("completed", async () => {
    const gateway = createTestGateway(() =>
      json({
        video_id: "video_done",
        model: "m",
        status: "completed",
        url: "https://storage.test/output.mp4?token=one",
      })
    );
    const response = await gateway.request(
      "/v1/videos/video_done/content?variant=thumbnail",
      {
        method: "GET",
        headers: { authorization: AUTHORIZATION },
        redirect: "manual",
      },
    );
    assertEquals(response.status, 302);
    assertEquals(
      response.headers.get("location"),
      "https://storage.test/output.mp4?token=one",
    );
    assertEquals(response.headers.get("cache-control"), "no-store");
    assertEquals(response.headers.get("referrer-policy"), "no-referrer");
  });

  await t.step("queued", async () => {
    const gateway = createTestGateway(() =>
      json({ video_id: "video_wait", model: "m", status: "in_progress" })
    );
    const response = await gateway.request("/v1/videos/video_wait/content", {
      method: "GET",
      headers: { authorization: AUTHORIZATION },
    });
    assertEquals(response.status, 409);
    assertObjectMatch(await responseJson(response), {
      error: { code: "video_not_ready" },
    });
  });

  await t.step("failed", async () => {
    const gateway = createTestGateway(() =>
      json({
        video_id: "video_failed",
        model: "m",
        status: "failed",
        error: { code: "generation_failed", message: "Unsafe input" },
      })
    );
    const response = await gateway.request("/v1/videos/video_failed/content", {
      method: "GET",
      headers: { authorization: AUTHORIZATION },
    });
    assertEquals(response.status, 409);
    assertObjectMatch(await responseJson(response), {
      error: { code: "video_failed", message: "Unsafe input" },
    });
  });

  await t.step("invalid URL", async () => {
    const gateway = createTestGateway(() =>
      json({
        video_id: "video_bad",
        model: "m",
        status: "completed",
        url: "javascript:alert(1)",
      })
    );
    const response = await gateway.request("/v1/videos/video_bad/content", {
      method: "GET",
      headers: { authorization: AUTHORIZATION },
    });
    assertEquals(response.status, 502);
    assertObjectMatch(await responseJson(response), {
      error: { code: "invalid_upstream_response" },
    });
  });

  await t.step("URL userinfo", async () => {
    const gateway = createTestGateway(() =>
      json({
        video_id: "video_credentials",
        model: "m",
        status: "completed",
        url: "https://user:secret@storage.test/output.mp4",
      })
    );
    const response = await gateway.request(
      "/v1/videos/video_credentials/content",
      {
        method: "GET",
        headers: { authorization: AUTHORIZATION },
      },
    );
    assertEquals(response.status, 502);
    assertObjectMatch(await responseJson(response), {
      error: { code: "invalid_upstream_response" },
    });
  });
});

Deno.test("Agnes errors retain status, error fields, and safe metadata", async () => {
  const gateway = createTestGateway(() =>
    json(
      {
        error: {
          message: "Rate limit reached",
          type: "rate_limit_error",
          param: "model",
          code: "rate_limit_exceeded",
        },
      },
      429,
      {
        "retry-after": "12",
        "x-request-id": "agnes_req",
        "set-cookie": "must-not-pass=yes",
      },
    )
  );
  const response = await gateway.request(
    "/v1/chat/completions",
    postJson({ model: "m", messages: [{}] }),
  );
  assertEquals(response.status, 429);
  assertEquals(response.headers.get("retry-after"), "12");
  assertEquals(response.headers.get("x-request-id"), "agnes_req");
  assertEquals(response.headers.get("set-cookie"), null);
  assertEquals(await response.json(), {
    error: {
      message: "Rate limit reached",
      type: "rate_limit_error",
      param: "model",
      code: "rate_limit_exceeded",
    },
  });
});

Deno.test("plain-text Agnes errors are normalized", async () => {
  const gateway = createTestGateway(() =>
    new Response("temporarily unavailable", { status: 503 })
  );
  const response = await gateway.request(
    "/v1/images/generations",
    postJson({ model: "m", prompt: "p", size: "1x1" }),
  );
  assertEquals(response.status, 503);
  assertObjectMatch(await responseJson(response), {
    error: {
      message: "temporarily unavailable",
      type: "api_error",
      param: null,
    },
  });
});

Deno.test("network failures become a 502 OpenAI connection error", async () => {
  const gateway = createTestGateway(() => {
    throw new TypeError("secret network details");
  });
  const response = await gateway.request(
    "/v1/images/edits",
    postJson({
      model: "m",
      prompt: "p",
      size: "1x1",
      image: "https://images.test/input.png",
    }),
  );
  assertEquals(response.status, 502);
  const body = await responseJson(response);
  assertObjectMatch(body, {
    error: {
      code: "upstream_connection_error",
      type: "api_connection_error",
    },
  });
  assertEquals(JSON.stringify(body).includes("secret network details"), false);
});

Deno.test("every endpoint normalizes an Agnes error response", async () => {
  const requests: Array<[string, RequestInit]> = [
    [
      "/v1/chat/completions",
      postJson({ model: "m", messages: [{ role: "user", content: "x" }] }),
    ],
    [
      "/v1/images/generations",
      postJson({ model: "m", prompt: "p", size: "1x1" }),
    ],
    [
      "/v1/images/edits",
      postJson({
        model: "m",
        prompt: "p",
        size: "1x1",
        image: "https://images.test/in.png",
      }),
    ],
    ["/v1/videos", postJson({ model: "m", prompt: "p" })],
    [
      "/v1/videos/video_error",
      { method: "GET", headers: { authorization: AUTHORIZATION } },
    ],
    [
      "/v1/videos/video_error/content",
      { method: "GET", headers: { authorization: AUTHORIZATION } },
    ],
  ];

  for (const [path, init] of requests) {
    const gateway = createTestGateway(() =>
      json({ message: "Agnes is busy", code: "busy" }, 503)
    );
    const response = await gateway.request(path, init);
    assertEquals(response.status, 503, path);
    assertObjectMatch(await responseJson(response), {
      error: { message: "Agnes is busy", code: "busy" },
    });
    assertEquals(gateway.calls.length, 1);
  }
});

Deno.test("video lookup retains representative Agnes error statuses", async () => {
  for (const status of [401, 404, 429, 503]) {
    const gateway = createTestGateway(() =>
      json(
        { error: { message: `status ${status}`, code: `code_${status}` } },
        status,
        { "retry-after": "9" },
      )
    );
    const response = await gateway.request("/v1/videos/video_error", {
      method: "GET",
      headers: { authorization: AUTHORIZATION },
    });
    assertEquals(response.status, status);
    assertEquals(response.headers.get("retry-after"), "9");
    assertObjectMatch(await responseJson(response), {
      error: { message: `status ${status}`, code: `code_${status}` },
    });
  }
});

Deno.test("client cancellation aborts the Agnes request signal", async () => {
  let start!: () => void;
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  let upstreamSignal: AbortSignal | undefined;
  const gateway = createTestGateway((request) => {
    upstreamSignal = request.signal;
    start();
    return new Promise<Response>((_resolve, reject) => {
      request.signal.addEventListener(
        "abort",
        () => reject(new DOMException("aborted", "AbortError")),
        { once: true },
      );
    });
  });
  const controller = new AbortController();
  const request = gateway.request("/v1/chat/completions", {
    ...postJson({ model: "m", messages: [{}] }),
    signal: controller.signal,
  });
  await started;
  controller.abort();

  const response = await request;
  assertEquals(response.status, 499);
  assertEquals(upstreamSignal?.aborted, true);
  assertObjectMatch(await responseJson(response), {
    error: { code: "client_aborted" },
  });
});
