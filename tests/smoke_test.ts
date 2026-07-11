import { assertEquals, assertThrows } from "@std/assert";
import {
  enforcePreviewWarnings,
  gatewayRequestUrl,
  hasOpenAIErrorEnvelope,
  parseGatewayBaseUrl,
  responseStatusSummary,
} from "../scripts/live_smoke.ts";

Deno.test("preview gateway URL accepts HTTPS and loopback HTTP base paths", () => {
  assertEquals(
    parseGatewayBaseUrl("https://gateway.example").href,
    "https://gateway.example/",
  );
  assertEquals(
    parseGatewayBaseUrl("http://localhost:8000/proxy/gateway/").href,
    "http://localhost:8000/proxy/gateway/",
  );
  assertEquals(
    parseGatewayBaseUrl("http://127.255.1.2:8000").href,
    "http://127.255.1.2:8000/",
  );
  assertEquals(
    parseGatewayBaseUrl("http://[::1]:8000").href,
    "http://[::1]:8000/",
  );
  assertEquals(
    gatewayRequestUrl(
      parseGatewayBaseUrl("https://gateway.example/proxy"),
      "/v1/chat/completions",
    ).href,
    "https://gateway.example/proxy/v1/chat/completions",
  );
});

Deno.test("preview gateway URL rejects unsafe or ambiguous values", () => {
  const cases: Array<[string | undefined, string]> = [
    [undefined, "required"],
    [" ", "required"],
    ["gateway.example", "absolute"],
    ["ftp://gateway.example", "HTTP or HTTPS"],
    ["https:\\\\gateway.example", "canonical HTTP(S)"],
    ["http://gateway.example", "must use HTTPS"],
    ["http://192.168.1.10", "must use HTTPS"],
    ["http://localhost.example", "must use HTTPS"],
    ["http://[::2]", "must use HTTPS"],
    ["https://user:password@gateway.example", "credentials"],
    ["https://@gateway.example", "credentials"],
    ["https://gateway.example?preview=true", "query or fragment"],
    ["https://gateway.example/#preview", "query or fragment"],
  ];

  for (const [value, expectedMessage] of cases) {
    assertThrows(
      () => parseGatewayBaseUrl(value),
      Error,
      expectedMessage,
    );
  }
});

Deno.test("smoke error summaries expose only safe status and code fields", () => {
  const response = new Response(null, { status: 429 });
  assertEquals(
    responseStatusSummary(response, {
      error: { message: "sensitive upstream detail", code: "rate_limit" },
    }),
    "HTTP 429, code rate_limit",
  );
  assertEquals(
    responseStatusSummary(response, {
      error: { code: "sk-secret-looking-value" },
    }),
    "HTTP 429",
  );
  assertEquals(
    responseStatusSummary(response, {
      error: { code: "unsafe code containing details" },
    }),
    "HTTP 429",
  );
});

Deno.test("smoke authentication checks require a complete OpenAI error envelope", () => {
  assertEquals(
    hasOpenAIErrorEnvelope({
      error: {
        message: "Invalid API key.",
        type: "authentication_error",
        param: null,
        code: "invalid_api_key",
      },
    }),
    true,
  );
  assertEquals(
    hasOpenAIErrorEnvelope({ error: { message: "Incomplete" } }),
    false,
  );
});

Deno.test("preview warnings are strict while local warnings remain diagnostic", () => {
  enforcePreviewWarnings(true, 0);
  enforcePreviewWarnings(false, 2);
  assertThrows(
    () => enforcePreviewWarnings(true, 1),
    Error,
    "Strict preview checks failed",
  );
});
