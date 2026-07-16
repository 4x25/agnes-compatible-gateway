import { gateway } from "../../../../lib/runtime.ts";
import { define } from "../../../../utils.ts";

export const handler = define.handlers({
  OPTIONS() {
    return gateway.handleOptions();
  },
  GET(ctx) {
    return gateway.handleVideoContent(ctx.req, ctx.params.video_id);
  },
});
