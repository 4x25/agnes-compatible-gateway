import { App, type Context, HttpError, type Middleware } from "fresh";
import {
  clientCancelledError,
  invalidParameter,
  jsonResponse,
  missingParameter,
  normalizeUpstreamError,
  openAIError,
  safeResponseHeaders,
} from "./errors.ts";
import {
  buildChatRequest,
  buildImageEditRequest,
  buildImageGenerationRequest,
  buildVideoRequest,
  type BuiltImageGenerationRequest,
  IMAGE_EDIT_REQUEST_BODY_LIMIT_BYTES,
  parseJsonBody,
  parseVideoBody,
  transformCreatedVideo,
  transformRetrievedVideo,
  transformSingleImageGenerationResponse,
  videoFailureMessage,
} from "./transforms.ts";
import {
  type AgnesUrls,
  createAgnesUrls,
  DEFAULT_AGNES_BASE_URL,
  parseHttpUrlWithoutUserinfo,
  passthroughResponse,
  readJsonObject,
  readJsonObjectWithLimit,
  requestUpstream,
} from "./upstream.ts";

export { DEFAULT_AGNES_BASE_URL } from "./upstream.ts";
export const IMAGE_GENERATION_FANOUT_RESPONSE_LIMIT_BYTES = 64 * 1024 * 1024;

export interface GatewayAppOptions {
  agnesBaseUrl?: string | URL;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

interface GatewayRuntime {
  fetch: typeof globalThis.fetch;
  now: () => number;
  urls: AgnesUrls;
}

interface VideoUpstreamResult {
  body: Record<string, unknown>;
  response: Response;
}

type GatewayState = Record<string, never>;
type AuthorizedHandler = (
  ctx: Context<GatewayState>,
  authorization: string,
) => Response | Promise<Response>;

function withAuthorization(
  handler: AuthorizedHandler,
): Middleware<GatewayState> {
  return (ctx) => {
    const authorization = ctx.req.headers.get("authorization");
    if (authorization === null || authorization.trim().length === 0) {
      return openAIError(401, "Missing Authorization header.", {
        type: "invalid_request_error",
        code: "invalid_api_key",
      });
    }
    return handler(ctx, authorization);
  };
}

function jsonRequestInit(
  authorization: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
  eventStream = false,
): RequestInit {
  const headers = new Headers({
    authorization,
    "content-type": "application/json",
    accept: eventStream ? "text/event-stream" : "application/json",
  });

  return {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  };
}

function attachSafeUpstreamHeaders(
  response: Response,
  sourceHeaders: Headers,
): Response {
  const headers = safeResponseHeaders(sourceHeaders);
  const contentType = response.headers.get("content-type");
  if (contentType !== null) headers.set("content-type", contentType);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function successfulResponseOrError(
  runtime: GatewayRuntime,
  url: URL,
  init: RequestInit,
): Promise<Response> {
  const result = await requestUpstream(runtime.fetch, url, init);
  if (result.error !== undefined) return result.error;
  if (result.response === undefined) {
    return openAIError(502, "Unable to connect to the Agnes API.", {
      type: "api_connection_error",
      code: "upstream_connection_error",
    });
  }
  return result.response;
}

async function handleChat(
  runtime: GatewayRuntime,
  ctx: Context<GatewayState>,
  authorization: string,
): Promise<Response> {
  const parsed = await parseJsonBody(ctx.req);
  if ("error" in parsed) return parsed.error;
  const transformed = buildChatRequest(parsed.value);
  if ("error" in transformed) return transformed.error;

  const stream = transformed.value.stream === true;
  const response = await successfulResponseOrError(
    runtime,
    runtime.urls.api("chat/completions"),
    jsonRequestInit(
      authorization,
      transformed.value,
      ctx.req.signal,
      stream,
    ),
  );
  if (!response.ok) {
    return await normalizeUpstreamError(response, ctx.req.signal);
  }
  return passthroughResponse(response, { eventStream: stream });
}

async function executeImageGenerationRequest(
  runtime: GatewayRuntime,
  authorization: string,
  request: BuiltImageGenerationRequest,
  signal: AbortSignal,
): Promise<Response> {
  const requestImage = () =>
    successfulResponseOrError(
      runtime,
      runtime.urls.api("images/generations"),
      jsonRequestInit(
        authorization,
        request.body,
        signal,
      ),
    );

  if (request.count === 1) {
    const response = await requestImage();
    if (!response.ok) {
      return await normalizeUpstreamError(response, signal);
    }
    return passthroughResponse(response);
  }

  const data: Record<string, unknown>[] = [];
  let created: number | undefined;
  let lastResponse: Response | undefined;
  let remainingBytes = IMAGE_GENERATION_FANOUT_RESPONSE_LIMIT_BYTES;

  for (let index = 0; index < request.count; index++) {
    if (signal.aborted) return clientCancelledError();

    const response = await requestImage();
    if (!response.ok) {
      return await normalizeUpstreamError(response, signal);
    }
    const upstream = await readJsonObjectWithLimit(response, remainingBytes);
    if (signal.aborted) return clientCancelledError();
    if (upstream instanceof Response) return upstream;
    remainingBytes -= upstream.byteLength;
    const image = transformSingleImageGenerationResponse(
      upstream.value,
      request.outputField,
    );
    if ("error" in image) {
      return attachSafeUpstreamHeaders(image.error, response.headers);
    }

    created ??= image.value.created;
    data.push(image.value.image);
    lastResponse = response;
  }

  if (created === undefined || lastResponse === undefined) {
    return openAIError(500, "An internal gateway error occurred.", {
      type: "api_error",
      code: "internal_error",
    });
  }

  return jsonResponse(
    { created, data },
    200,
    lastResponse.headers,
  );
}

async function handleImageGeneration(
  runtime: GatewayRuntime,
  ctx: Context<GatewayState>,
  authorization: string,
): Promise<Response> {
  const parsed = await parseJsonBody(ctx.req);
  if ("error" in parsed) return parsed.error;
  const transformed = buildImageGenerationRequest(parsed.value);
  if ("error" in transformed) return transformed.error;
  return await executeImageGenerationRequest(
    runtime,
    authorization,
    transformed.value,
    ctx.req.signal,
  );
}

async function handleImageEdit(
  runtime: GatewayRuntime,
  ctx: Context<GatewayState>,
  authorization: string,
): Promise<Response> {
  const parsed = await parseJsonBody(
    ctx.req,
    IMAGE_EDIT_REQUEST_BODY_LIMIT_BYTES,
  );
  if ("error" in parsed) return parsed.error;
  const transformed = buildImageEditRequest(parsed.value);
  if ("error" in transformed) return transformed.error;

  const response = await successfulResponseOrError(
    runtime,
    runtime.urls.api("images/generations"),
    jsonRequestInit(authorization, transformed.value, ctx.req.signal),
  );
  if (!response.ok) {
    return await normalizeUpstreamError(response, ctx.req.signal);
  }
  return passthroughResponse(response);
}

async function handleVideoCreate(
  runtime: GatewayRuntime,
  ctx: Context<GatewayState>,
  authorization: string,
): Promise<Response> {
  const parsed = await parseVideoBody(ctx.req);
  if ("error" in parsed) return parsed.error;
  const transformed = buildVideoRequest(parsed.value);
  if ("error" in transformed) return transformed.error;

  const response = await successfulResponseOrError(
    runtime,
    runtime.urls.api("videos"),
    jsonRequestInit(authorization, transformed.value.body, ctx.req.signal),
  );
  if (!response.ok) {
    return await normalizeUpstreamError(response, ctx.req.signal);
  }

  const upstream = await readJsonObject(response);
  if (upstream instanceof Response) return upstream;
  const video = transformCreatedVideo(upstream, transformed.value.prompt);
  if ("error" in video) return video.error;
  return jsonResponse(video.value, response.status, response.headers);
}

function videoId(ctx: Context<GatewayState>): string | Response {
  const value = ctx.params.video_id;
  if (typeof value !== "string" || value.trim().length === 0) {
    return missingParameter("video_id");
  }
  try {
    return decodeURIComponent(value);
  } catch {
    return invalidParameter("video_id", "a valid URL path identifier");
  }
}

function videoGetInit(authorization: string, signal: AbortSignal): RequestInit {
  return {
    method: "GET",
    headers: {
      authorization,
      accept: "application/json",
    },
    signal,
  };
}

async function getVideoUpstream(
  runtime: GatewayRuntime,
  ctx: Context<GatewayState>,
  authorization: string,
  id: string,
): Promise<Response | VideoUpstreamResult> {
  const response = await successfulResponseOrError(
    runtime,
    runtime.urls.videoStatus(id),
    videoGetInit(authorization, ctx.req.signal),
  );
  if (!response.ok) {
    return await normalizeUpstreamError(response, ctx.req.signal);
  }
  const body = await readJsonObject(response);
  return body instanceof Response ? body : { body, response };
}

async function handleVideoGet(
  runtime: GatewayRuntime,
  ctx: Context<GatewayState>,
  authorization: string,
): Promise<Response> {
  const id = videoId(ctx);
  if (id instanceof Response) return id;
  const upstream = await getVideoUpstream(runtime, ctx, authorization, id);
  if (upstream instanceof Response) return upstream;

  const video = transformRetrievedVideo(upstream.body, id);
  if ("error" in video) return video.error;
  return jsonResponse(
    video.value,
    upstream.response.status,
    upstream.response.headers,
  );
}

function downloadableUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return parseHttpUrlWithoutUserinfo(value)?.toString();
}

async function handleVideoContent(
  runtime: GatewayRuntime,
  ctx: Context<GatewayState>,
  authorization: string,
): Promise<Response> {
  const id = videoId(ctx);
  if (id instanceof Response) return id;
  const upstream = await getVideoUpstream(runtime, ctx, authorization, id);
  if (upstream instanceof Response) return upstream;

  if (upstream.body.status === "failed") {
    return openAIError(409, videoFailureMessage(upstream.body), {
      code: "video_failed",
      headers: safeResponseHeaders(upstream.response.headers),
    });
  }
  if (upstream.body.status !== "completed") {
    return openAIError(409, "The video is not ready for download.", {
      code: "video_not_ready",
      headers: safeResponseHeaders(upstream.response.headers),
    });
  }

  const location = downloadableUrl(upstream.body.url);
  if (location === undefined) {
    return openAIError(
      502,
      "Agnes returned a completed video without a valid URL.",
      {
        type: "api_error",
        code: "invalid_upstream_response",
        headers: safeResponseHeaders(upstream.response.headers),
      },
    );
  }

  const headers = safeResponseHeaders(upstream.response.headers);
  headers.set("location", location);
  headers.set("cache-control", "no-store");
  headers.set("referrer-policy", "no-referrer");
  return new Response(null, { status: 302, headers });
}

export function createGatewayApp(
  options: GatewayAppOptions = {},
): App<GatewayState> {
  const runtime: GatewayRuntime = {
    fetch: options.fetch ?? globalThis.fetch,
    now: options.now ?? (() => Date.now()),
    urls: createAgnesUrls(options.agnesBaseUrl ?? DEFAULT_AGNES_BASE_URL),
  };
  const app = new App<GatewayState>();

  app.use(async (ctx) => {
    try {
      return await ctx.next();
    } catch (error) {
      if (error instanceof HttpError) {
        return openAIError(
          error.status,
          error.status === 405
            ? "The HTTP method is not allowed for this endpoint."
            : error.status === 404
            ? "The requested API endpoint was not found."
            : "The request could not be completed.",
          {
            code: error.status === 405
              ? "method_not_allowed"
              : error.status === 404
              ? "not_found"
              : "http_error",
          },
        );
      }
      return openAIError(500, "An internal gateway error occurred.", {
        type: "api_error",
        code: "internal_error",
      });
    }
  });

  app.post(
    "/v1/chat/completions",
    withAuthorization((ctx, auth) => handleChat(runtime, ctx, auth)),
  );
  app.post(
    "/v1/images/generations",
    withAuthorization((ctx, auth) => handleImageGeneration(runtime, ctx, auth)),
  );
  app.post(
    "/v1/images/edits",
    withAuthorization((ctx, auth) => handleImageEdit(runtime, ctx, auth)),
  );
  app.post(
    "/v1/videos",
    withAuthorization((ctx, auth) => handleVideoCreate(runtime, ctx, auth)),
  );
  app.get(
    "/v1/videos",
    withAuthorization(() => missingParameter("video_id")),
  );
  app.get(
    "/v1/videos/:video_id/content",
    withAuthorization((ctx, auth) => handleVideoContent(runtime, ctx, auth)),
  );
  app.get(
    "/v1/videos/:video_id",
    withAuthorization((ctx, auth) => handleVideoGet(runtime, ctx, auth)),
  );

  app.notFound((ctx) => {
    const isApiPath = ctx.url.pathname === "/v1" ||
      ctx.url.pathname.startsWith("/v1/");
    return openAIError(
      404,
      isApiPath ? "The requested API endpoint was not found." : "Not found.",
      { code: "not_found" },
    );
  });

  return app;
}
