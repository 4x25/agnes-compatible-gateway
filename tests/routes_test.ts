import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.14";

const { app, healthHandler, chatHandler } = await loadFreshSourceSurface();

/**
 * Load the real Fresh app in source-test mode without requiring `_fresh`.
 *
 * Fresh deliberately requires generated assets when `DENO_DEPLOYMENT_ID` is
 * present. Route tests execute `main.ts` directly before the production build,
 * so temporarily hiding only that deployment marker lets Fresh install its
 * in-memory build cache. The application middleware, file-system router, and
 * route adapters remain the production implementations under test.
 */
async function loadFreshSourceSurface() {
  const deploymentId = Deno.env.get("DENO_DEPLOYMENT_ID");
  try {
    Deno.env.delete("DENO_DEPLOYMENT_ID");
    const { app } = await import("../main.ts");
    const { handler: healthHandler } = await import("../routes/healthz.ts");
    const { handler: chatHandler } = await import(
      "../routes/v1/chat/completions.ts"
    );
    return { app, healthHandler, chatHandler };
  } finally {
    if (deploymentId === undefined) {
      Deno.env.delete("DENO_DEPLOYMENT_ID");
    } else {
      Deno.env.set("DENO_DEPLOYMENT_ID", deploymentId);
    }
  }
}

Deno.test("health route is independent of Agnes credentials", async () => {
  const response = await healthHandler.GET();
  assertEquals(response.status, 200);
  assertEquals(await response.json(), { status: "ok" });
  assertEquals(response.headers.get("cache-control"), "no-store");
});

Deno.test("Fresh API adapters answer OPTIONS without touching upstream", async () => {
  const response = await chatHandler.OPTIONS();
  assertEquals(response.status, 204);
  assertStringIncludes(
    response.headers.get("access-control-allow-methods") ?? "",
    "POST",
  );
});

Deno.test("unknown v1 routes and unsupported methods use OpenAI JSON errors", async () => {
  const callerSecret = "sk-agnes-must-not-enter-logs";
  const logs: string[] = [];
  const originalInfo = console.info;
  console.info = (...values: unknown[]) => {
    logs.push(values.map(String).join(" "));
  };
  try {
    const serve = app.handler();
    const missing = await serve(
      new Request("http://localhost/v1/not-real", {
        headers: { "x-request-id": callerSecret },
      }),
    );
    const missingPayload = await missing.json();
    assertEquals(missing.status, 404);
    assertEquals(missingPayload.error.code, "endpoint_not_found");
    assertEquals(missing.headers.get("access-control-allow-origin"), "*");
    assertEquals(missing.headers.get("x-request-id"), callerSecret);

    const wrongMethod = await serve(
      new Request(
        "http://localhost/v1/chat/completions",
        { method: "GET" },
      ),
    );
    const methodPayload = await wrongMethod.json();
    assertEquals(wrongMethod.status, 405);
    assertEquals(methodPayload.error.code, "method_not_allowed");
    assertEquals(wrongMethod.headers.get("access-control-allow-origin"), "*");
  } finally {
    console.info = originalInfo;
  }
  assertEquals(logs.length, 2);
  assertEquals(logs.some((line) => line.includes(callerSecret)), false);
  assertStringIncludes(logs[0], '"request_id":"sha256:');
});
