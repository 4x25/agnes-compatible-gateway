import { assert, assertEquals } from "jsr:@std/assert@1.0.14";
import { parse } from "@std/yaml";

/**
 * Keep the checked-in API description machine-readable and aligned with the
 * intentionally small public route set. Deeper wire behavior is exercised by
 * the handler and official-SDK tests; this test catches YAML/schema drift.
 */
Deno.test("OpenAPI 3.1 document describes exactly the public gateway routes", async () => {
  const source = await Deno.readTextFile("static/openapi.yaml");
  const document = parse(source) as Record<string, unknown>;

  assertEquals(document.openapi, "3.1.0");
  const paths = objectValue(document.paths, "paths");
  assertEquals(Object.keys(paths).sort(), [
    "/healthz",
    "/v1/chat/completions",
    "/v1/images/edits",
    "/v1/images/generations",
    "/v1/videos",
    "/v1/videos/{video_id}",
    "/v1/videos/{video_id}/content",
  ]);
  assertEquals(paths["/v1/video/generations"], undefined);

  const cors = objectValue(document["x-cors"], "x-cors");
  assertEquals(cors.allowCredentials, false);
  assertEquals(cors.allowOrigins, ["*"]);
  assertEquals(cors.allowHeaders, [
    "Accept",
    "Authorization",
    "Content-Type",
    "Range",
    "X-Request-ID",
  ]);

  const components = objectValue(document.components, "components");
  const schemes = objectValue(components.securitySchemes, "securitySchemes");
  const bearer = objectValue(schemes.AgnesBearer, "AgnesBearer");
  assertEquals(bearer.type, "http");
  assertEquals(bearer.scheme, "bearer");

  const health = objectValue(paths["/healthz"], "/healthz");
  const healthGet = objectValue(health.get, "/healthz.get");
  assertEquals(healthGet.security, []);
  for (const path of Object.keys(paths).filter((path) => path !== "/healthz")) {
    assert(
      source.includes(`${path}:`),
      `OpenAPI source must contain the route ${path}`,
    );
  }
});

function objectValue(value: unknown, label: string): Record<string, unknown> {
  assert(
    typeof value === "object" && value !== null && !Array.isArray(value),
    `${label} must be an object`,
  );
  return value as Record<string, unknown>;
}
