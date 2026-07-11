import { createGatewayApp, DEFAULT_AGNES_BASE_URL } from "./gateway/app.ts";

export const app = createGatewayApp({
  agnesBaseUrl: Deno.env.get("AGNES_BASE_URL") ?? DEFAULT_AGNES_BASE_URL,
});
