import { createGateway } from "./gateway.ts";

/** Shared stateless runtime instance used by Fresh route adapters. */
export const gateway = createGateway();
