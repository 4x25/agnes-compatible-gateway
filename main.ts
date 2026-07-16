import { App, HttpError, staticFiles } from "fresh";
import { GatewayError } from "./lib/errors.ts";
import {
  corsHeaders,
  errorResponse,
  getRequestId,
  preflightResponse,
  requestIdLogLabel,
} from "./lib/http.ts";
import type { State } from "./utils.ts";

export const app = new App<State>();

app.use(staticFiles());

// Log only operational metadata. Authorization headers and bodies never enter
// logs; request IDs are hashed and dynamic task IDs use a stable route label.
app.use(async (ctx) => {
  const startedAt = performance.now();
  const url = new URL(ctx.req.url);
  const isApi = url.pathname === "/v1" || url.pathname.startsWith("/v1/");
  let response: Response;
  try {
    response = isApi && ctx.req.method === "OPTIONS"
      ? preflightResponse()
      : await ctx.next();
  } catch (error) {
    if (!isApi) throw error;
    response = errorResponse(
      normalizeFreshError(error, ctx.req),
      { requestId: getRequestId(ctx.req) },
    );
  }

  if (isApi) {
    if (response.status === 404 || response.status === 405) {
      if (response.body) await response.body.cancel();
      const methodNotAllowed = response.status === 405 ||
        (response.status === 404 && isWrongMethod(ctx.req));
      response = errorResponse(
        new GatewayError(
          methodNotAllowed ? 405 : response.status,
          methodNotAllowed
            ? "The requested HTTP method is not supported for this endpoint."
            : "The requested API endpoint does not exist.",
          {
            type: "invalid_request_error",
            code: methodNotAllowed
              ? "method_not_allowed"
              : "endpoint_not_found",
          },
        ),
        { requestId: getRequestId(ctx.req) },
      );
    } else if (
      response.status >= 400 && !response.headers.has("x-request-id")
    ) {
      if (response.body) await response.body.cancel();
      response = errorResponse(
        new GatewayError(
          response.status,
          "The API request could not be completed.",
          { code: "request_failed" },
        ),
        { requestId: getRequestId(ctx.req) },
      );
    } else {
      const headers = new Headers(response.headers);
      for (const [name, value] of corsHeaders()) {
        if (!headers.has(name)) headers.set(name, value);
      }
      if (!headers.has("x-request-id")) {
        headers.set("x-request-id", getRequestId(ctx.req));
      }
      response = new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }
  }

  if (isApi || url.pathname === "/healthz") {
    console.info(JSON.stringify({
      request_id: await requestIdLogLabel(
        response.headers.get("x-request-id"),
      ),
      method: ctx.req.method,
      route: safeRouteLabel(url.pathname),
      status: response.status,
      duration_ms: Math.round(performance.now() - startedAt),
    }));
  }
  return response;
});

// Include file-system based routes here
app.fsRoutes();

function normalizeFreshError(error: unknown, request: Request): unknown {
  if (!(error instanceof HttpError)) return error;
  const methodNotAllowed = error.status === 405 ||
    (error.status === 404 && isWrongMethod(request));
  const status = methodNotAllowed ? 405 : error.status;
  const notFound = status === 404;
  return new GatewayError(
    status,
    methodNotAllowed
      ? "The requested HTTP method is not supported for this endpoint."
      : notFound
      ? "The requested API endpoint does not exist."
      : "The API request could not be completed.",
    {
      type: "invalid_request_error",
      code: methodNotAllowed
        ? "method_not_allowed"
        : notFound
        ? "endpoint_not_found"
        : "request_failed",
    },
  );
}

function isWrongMethod(request: Request): boolean {
  const path = new URL(request.url).pathname.replace(/\/$/, "");
  const expected = path === "/v1/chat/completions" ||
      path === "/v1/images/generations" || path === "/v1/images/edits" ||
      path === "/v1/videos"
    ? "POST"
    : /^\/v1\/videos\/[^/]+(?:\/content)?$/.test(path)
    ? "GET"
    : null;
  return expected !== null && request.method !== expected &&
    request.method !== "OPTIONS";
}

/** Collapse all caller-controlled path segments before operational logging. */
function safeRouteLabel(pathname: string): string {
  const path = pathname.replace(/\/$/, "") || "/";
  if (path === "/healthz") return path;
  if (
    path === "/v1/chat/completions" ||
    path === "/v1/images/generations" ||
    path === "/v1/images/edits" || path === "/v1/videos"
  ) {
    return path;
  }
  if (/^\/v1\/videos\/[^/]+\/content$/.test(path)) {
    return "/v1/videos/:video_id/content";
  }
  if (/^\/v1\/videos\/[^/]+$/.test(path)) {
    return "/v1/videos/:video_id";
  }
  return "/v1/:unknown";
}
