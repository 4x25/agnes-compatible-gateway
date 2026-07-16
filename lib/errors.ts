/** A controlled failure that is safe to expose in OpenAI's error envelope. */
export class GatewayError extends Error {
  readonly status: number;
  readonly type: string;
  readonly param: string | null;
  readonly code: string;
  readonly headers: Headers;

  constructor(
    status: number,
    message: string,
    options: {
      type?: string;
      param?: string | null;
      code?: string;
      headers?: HeadersInit;
    } = {},
  ) {
    super(message);
    this.name = "GatewayError";
    this.status = status;
    this.type = options.type ?? defaultErrorType(status);
    this.param = options.param ?? null;
    this.code = options.code ?? defaultErrorCode(status);
    this.headers = new Headers(options.headers);
  }
}

function defaultErrorType(status: number): string {
  if (status === 401 || status === 403) return "authentication_error";
  if (status === 429) return "rate_limit_error";
  if (status >= 500) return "api_error";
  return "invalid_request_error";
}

function defaultErrorCode(status: number): string {
  if (status === 401) return "invalid_api_key";
  if (status === 403) return "insufficient_permissions";
  if (status === 429) return "rate_limit_exceeded";
  if (status >= 500) return "upstream_error";
  return "invalid_request";
}

/** Construct a validation error with a stable parameter name. */
export function invalidRequest(
  message: string,
  param: string | null = null,
  code = "invalid_request",
  status = 400,
): GatewayError {
  return new GatewayError(status, message, { param, code });
}
