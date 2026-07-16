import type { GatewayConfig, GatewayOptions } from "./types.ts";

export const DEFAULT_AGNES_BASE_URL = "https://apihub.agnes-ai.com/v1";
export const MEBIBYTE = 1024 * 1024;

/** Remove trailing slashes and reject unsafe or malformed upstream URLs. */
export function normalizeBaseUrl(value: string): string {
  const normalized = value.trim().replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new TypeError("AGNES_BASE_URL must be a valid absolute URL.");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new TypeError("AGNES_BASE_URL must use http or https.");
  }
  if (url.username || url.password) {
    throw new TypeError("AGNES_BASE_URL must not contain credentials.");
  }
  // URL normalizes a bare trailing `?`/`#` to an empty search/hash, but those
  // delimiters would still make appended endpoint paths part of a query or
  // fragment. Inspect the original normalized spelling as well.
  if (
    url.search || url.hash || normalized.includes("?") ||
    normalized.includes("#")
  ) {
    throw new TypeError("AGNES_BASE_URL must not contain a query or fragment.");
  }

  // Return the URL parser's canonical form so later string joining cannot be
  // affected by whitespace, dot segments, or an ambiguous trailing slash.
  return url.toString().replace(/\/+$/, "");
}

/** Join a path without allowing a leading slash to discard `/v1`. */
export function joinBaseUrl(baseUrl: string, path: string): string {
  return `${baseUrl}/${path.replace(/^\/+/, "")}`;
}

function configuredBaseUrl(): string {
  try {
    return Deno.env.get("AGNES_BASE_URL") || DEFAULT_AGNES_BASE_URL;
  } catch {
    // A restricted Deno process can still use the documented default.
    return DEFAULT_AGNES_BASE_URL;
  }
}

/** Build an immutable, fully-populated runtime configuration. */
export function resolveGatewayConfig(
  options: GatewayOptions = {},
): GatewayConfig {
  return {
    agnesBaseUrl: normalizeBaseUrl(
      options.agnesBaseUrl ?? configuredBaseUrl(),
    ),
    maxRequestBytes: options.maxRequestBytes ?? 50 * MEBIBYTE,
    maxFileBytes: options.maxFileBytes ?? 20 * MEBIBYTE,
    maxImageFiles: options.maxImageFiles ?? 16,
    maxImageResponseBytes: options.maxImageResponseBytes ?? 64 * MEBIBYTE,
    upstreamResponseHeaderTimeoutMs: options.upstreamResponseHeaderTimeoutMs ??
      360_000,
  };
}
