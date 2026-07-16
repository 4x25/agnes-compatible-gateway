/** A JSON object received from, or sent to, an HTTP API. */
export type JsonObject = Record<string, unknown>;

/**
 * The small subset of `fetch` used by the gateway.
 *
 * Keeping this type structural lets tests inject a deterministic in-memory
 * Agnes server without coupling the protocol conversion layer to Fresh.
 */
export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/** Runtime limits and upstream configuration used by a gateway instance. */
export interface GatewayConfig {
  agnesBaseUrl: string;
  maxRequestBytes: number;
  maxFileBytes: number;
  maxImageFiles: number;
  maxImageResponseBytes: number;
  /** Maximum wait for upstream response headers, not streamed body duration. */
  upstreamResponseHeaderTimeoutMs: number;
}

/** Dependencies and configuration overrides accepted by `createGateway`. */
export interface GatewayOptions extends Partial<GatewayConfig> {
  fetch?: FetchLike;
}

/** Metadata attached to every public API response. */
export interface ResponseContext {
  requestId: string;
  ignoredParams?: Iterable<string>;
}
