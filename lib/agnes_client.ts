import { joinApiRootUrl, joinBaseUrl } from "./config.ts";
import { GatewayError } from "./errors.ts";
import { safeUpstreamHeaders } from "./http.ts";
import type { FetchLike, GatewayConfig } from "./types.ts";

/** Minimal Agnes HTTP client. It deliberately has no key storage or retries. */
export class AgnesClient {
  constructor(
    private readonly config: GatewayConfig,
    private readonly fetchImpl: FetchLike,
  ) {}

  request(
    path: string,
    authorization: string,
    init: Omit<RequestInit, "headers"> & { headers?: HeadersInit } = {},
    options: { detachInboundSignalAfterHeaders?: boolean } = {},
  ): Promise<Response> {
    return this.requestCredentialed(
      joinBaseUrl(this.config.agnesBaseUrl, path),
      authorization,
      init,
      options,
    );
  }

  /** Call an Agnes endpoint adjacent to `/v1`, currently video polling. */
  requestApiRoot(
    path: string,
    authorization: string,
    init: Omit<RequestInit, "headers"> & { headers?: HeadersInit } = {},
    options: { detachInboundSignalAfterHeaders?: boolean } = {},
  ): Promise<Response> {
    return this.requestCredentialed(
      joinApiRootUrl(this.config.agnesBaseUrl, path),
      authorization,
      init,
      options,
    );
  }

  private requestCredentialed(
    url: string,
    authorization: string,
    init: Omit<RequestInit, "headers"> & { headers?: HeadersInit },
    options: { detachInboundSignalAfterHeaders?: boolean },
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("authorization", authorization);
    headers.set("accept", headers.get("accept") ?? "application/json");
    return this.fetchResponseHeaders(
      url,
      {
        ...init,
        // A redirect is not part of the configured Agnes API origin. Refusing
        // it makes credential isolation explicit instead of relying on each
        // runtime's cross-origin Authorization stripping behavior.
        redirect: "error",
        headers,
      },
      options.detachInboundSignalAfterHeaders ?? false,
    );
  }

  /** Fetch generated media without ever forwarding the Agnes credential. */
  requestMedia(
    url: string,
    range: string | null,
    signal?: AbortSignal,
  ): Promise<Response> {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new GatewayError(502, "Agnes returned an unsupported media URL.", {
        code: "invalid_upstream_response",
      });
    }
    const headers = new Headers({ accept: "video/*,application/octet-stream" });
    if (range) headers.set("range", range);
    return this.fetchResponseHeaders(
      parsed,
      {
        headers,
        redirect: "follow",
        signal,
      },
      true,
    );
  }

  /**
   * Bound the wait for headers and honor a disconnect only until they arrive.
   * Detaching afterwards is deliberate: older Deno Deploy runtimes can abort
   * an inbound signal after response headers are returned, which would cut off
   * an otherwise healthy proxied SSE/media stream. Downstream stream
   * cancellation still propagates through the shared upstream body itself.
   */
  private async fetchResponseHeaders(
    input: string | URL,
    init: RequestInit,
    detachInboundSignalAfterHeaders: boolean,
  ): Promise<Response> {
    const inboundSignal = init.signal ?? undefined;
    const controller = new AbortController();
    let timedOut = false;
    const abortFromInbound = () => controller.abort(inboundSignal?.reason);
    if (inboundSignal?.aborted) abortFromInbound();
    else {
      inboundSignal?.addEventListener("abort", abortFromInbound, {
        once: true,
      });
    }
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort("upstream response header timeout");
    }, this.config.upstreamResponseHeaderTimeoutMs);

    let retainInboundListener = false;
    const detachInboundListener = () =>
      inboundSignal?.removeEventListener("abort", abortFromInbound);

    try {
      const response = await this.fetchImpl(input, {
        ...init,
        signal: controller.signal,
      });
      if (
        inboundSignal && response.body && !detachInboundSignalAfterHeaders
      ) {
        // Buffered endpoints still own their upstream body after headers
        // arrive. Keep client cancellation connected until that body settles.
        // Streaming endpoints opt out because Deno Deploy may abort the inbound
        // signal after the handler has already returned a healthy response.
        retainInboundListener = true;
        return responseWithLifecycle(response, detachInboundListener);
      }
      return response;
    } catch (error) {
      if (timedOut) {
        throw new GatewayError(
          504,
          "The upstream did not return response headers before the gateway timeout.",
          { type: "api_error", code: "upstream_timeout" },
        );
      }
      if (inboundSignal?.aborted) {
        throw new GatewayError(499, "The API request was cancelled.", {
          type: "request_error",
          code: "request_cancelled",
        });
      }
      throw error;
    } finally {
      clearTimeout(timer);
      if (!retainInboundListener) detachInboundListener();
    }
  }
}

/**
 * Preserve HTTP metadata and release a buffered response's inbound abort
 * listener as soon as its body closes, errors, or is explicitly canceled.
 */
function responseWithLifecycle(
  response: Response,
  release: () => void,
): Response {
  const reader = response.body!.getReader();
  let released = false;
  const releaseOnce = () => {
    if (released) return;
    released = true;
    release();
  };

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          releaseOnce();
          controller.close();
        } else {
          controller.enqueue(chunk.value);
        }
      } catch (error) {
        releaseOnce();
        controller.error(error);
      }
    },
    async cancel(reason) {
      releaseOnce();
      await reader.cancel(reason);
    },
  });

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/** Convert any non-2xx Agnes response into a safe OpenAI-style failure. */
export async function ensureUpstreamOk(response: Response): Promise<Response> {
  if (response.ok) return response;

  const status = response.status >= 400 && response.status <= 599
    ? response.status
    : 502;
  // Upstream error bodies are untrusted and may echo the Authorization token,
  // prompt, or an entire Data URI. Never reflect even a structured `message`
  // field. Status and allowlisted correlation/rate-limit headers provide safe
  // diagnostic context; canceling the body also avoids buffering secret data.
  try {
    await response.body?.cancel("upstream response rejected");
  } catch {
    // A transport may have already closed the stream. Error normalization must
    // still complete with the original safe status and metadata.
  }
  throw new GatewayError(
    status,
    `Agnes upstream request failed with status ${status}.`,
    {
      type: status === 401 || status === 403
        ? "authentication_error"
        : status === 429
        ? "rate_limit_error"
        : "upstream_error",
      code: status === 429 ? "rate_limit_exceeded" : "upstream_error",
      headers: safeUpstreamHeaders(response.headers),
    },
  );
}
