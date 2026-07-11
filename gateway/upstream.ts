import {
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

export function createAgnesUrls(value: string | URL): AgnesUrls {
  const baseUrl = new URL(value.toString());

  if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
    throw new TypeError("AGNES_BASE_URL must use http or https.");
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
): Promise<UpstreamResult> {
  try {
    return { response: await fetcher(url, init) };
  } catch {
    if (init.signal?.aborted) {
      return {
        error: openAIError(499, "The client cancelled the request.", {
          type: "api_connection_error",
          code: "client_aborted",
        }),
      };
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

  return invalidUpstreamResponse("Agnes returned an invalid JSON response.");
}
