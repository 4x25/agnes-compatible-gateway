import {
  clientCancelledError,
  invalidUpstreamResponse,
  openAIError,
  safeResponseHeaders,
} from "./errors.ts";

export const DEFAULT_AGNES_BASE_URL = "https://apihub.agnes-ai.com/v1";

export interface AgnesUrls {
  readonly baseUrl: URL;
  api(path: string): URL;
  videoStatus(videoId: string): URL;
}

export interface UpstreamResult {
  response?: Response;
  error?: Response;
}

export interface GatewayLogger {
  info(event: string, fields: Record<string, unknown>): void;
  error(event: string, fields: Record<string, unknown>): void;
}

export const DEFAULT_GATEWAY_LOGGER: GatewayLogger = {
  info(event, fields) {
    console.info(JSON.stringify({ event, ...fields }));
  },
  error(event, fields) {
    console.error(JSON.stringify({ event, ...fields }));
  },
};

function rawAuthorityHasUserinfo(value: string): boolean {
  const match = /^[a-z][a-z\d+.-]*:\/\/([^/?#]*)/i.exec(value);
  return match?.[1].includes("@") ?? false;
}

export function parseHttpUrlWithoutUserinfo(value: string): URL | undefined {
  if (!/^https?:\/\//i.test(value) || rawAuthorityHasUserinfo(value)) {
    return undefined;
  }

  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username.length > 0 || url.password.length > 0
    ) {
      return undefined;
    }
    return url;
  } catch {
    return undefined;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "[::1]") return true;

  const octets = hostname.split(".");
  return octets.length === 4 && octets[0] === "127" &&
    octets.every((octet) => /^\d+$/.test(octet));
}

export function createAgnesUrls(value: string | URL): AgnesUrls {
  const serialized = value.toString();
  const baseUrl = new URL(serialized);

  if (baseUrl.protocol !== "https:") {
    if (baseUrl.protocol !== "http:" || !isLoopbackHostname(baseUrl.hostname)) {
      throw new TypeError(
        "AGNES_BASE_URL must use https, except for loopback HTTP development hosts.",
      );
    }
  }
  if (
    baseUrl.username.length > 0 || baseUrl.password.length > 0 ||
    rawAuthorityHasUserinfo(serialized)
  ) {
    throw new TypeError("AGNES_BASE_URL must not include URL userinfo.");
  }
  if (baseUrl.search.length > 0 || baseUrl.hash.length > 0) {
    throw new TypeError("AGNES_BASE_URL must not include a query or fragment.");
  }

  baseUrl.pathname = baseUrl.pathname.replace(/\/+$/, "");
  if (!baseUrl.pathname.endsWith("/v1")) {
    throw new TypeError("AGNES_BASE_URL must end with /v1.");
  }

  return {
    baseUrl,
    api(path: string): URL {
      const url = new URL(baseUrl);
      url.pathname = `${baseUrl.pathname}/${path.replace(/^\/+/, "")}`;
      return url;
    },
    videoStatus(videoId: string): URL {
      const url = new URL(baseUrl);
      url.pathname = `${baseUrl.pathname.slice(0, -3)}/agnesapi`.replace(
        /\/{2,}/g,
        "/",
      );
      url.searchParams.set("video_id", videoId);
      return url;
    },
  };
}

export async function requestUpstream(
  fetcher: typeof fetch,
  url: URL,
  init: RequestInit,
  logger: GatewayLogger = DEFAULT_GATEWAY_LOGGER,
): Promise<UpstreamResult> {
  const startedAt = Date.now();
  const method = init.method ?? "GET";
  logger.info("agnes_request_started", {
    method,
    path: url.pathname,
  });
  try {
    const response = await fetcher(url, init);
    logger.info("agnes_request_finished", {
      method,
      path: url.pathname,
      status: response.status,
      duration_ms: Date.now() - startedAt,
    });
    return { response };
  } catch (error) {
    logger.error("agnes_request_failed", {
      method,
      path: url.pathname,
      duration_ms: Date.now() - startedAt,
      cancelled: init.signal?.aborted ?? false,
      error: error instanceof Error ? error.name : "unknown_error",
    });
    if (init.signal?.aborted) {
      return { error: clientCancelledError() };
    }

    return {
      error: openAIError(502, "Unable to connect to the Agnes API.", {
        type: "api_connection_error",
        code: "upstream_connection_error",
      }),
    };
  }
}

export function passthroughResponse(
  response: Response,
  options: { eventStream?: boolean } = {},
): Response {
  const headers = safeResponseHeaders(response.headers);
  const contentType = response.headers.get("content-type");
  if (contentType !== null) headers.set("content-type", contentType);

  if (options.eventStream) {
    headers.set("content-type", contentType ?? "text/event-stream");
    headers.set("cache-control", "no-cache");
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export async function readJsonObject(
  response: Response,
): Promise<Record<string, unknown> | Response> {
  try {
    const value: unknown = await response.json();
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // The common error response below is deliberately independent of the
    // upstream payload so malformed HTML or binary data is never reflected.
  }

  return invalidUpstreamResponse(
    "Agnes returned an invalid JSON response.",
    response.headers,
  );
}
