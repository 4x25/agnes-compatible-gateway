import { gateway } from "../../../lib/runtime.ts";
import { define } from "../../../utils.ts";

export const handler = define.handlers({
  OPTIONS() {
    return gateway.handleOptions();
  },
  POST(ctx) {
    return gateway.handleImageEdits(ctx.req);
  },
});
