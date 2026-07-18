import { AgnesClient, ensureUpstreamOk } from "./agnes_client.ts";
import { resolveGatewayConfig } from "./config.ts";
import { GatewayError } from "./errors.ts";
import {
  jsonEditImages,
  multipartEditImages,
  multipartVideoReference,
  parseFormFields,
} from "./form_data.ts";
import {
  errorResponse,
  getRequestId,
  isJsonObject,
  jsonResponse,
  parseJsonRequest,
  parseMultipartRequest,
  preflightResponse,
  readStreamBytes,
  requireBearerAuthorization,
  safeUpstreamHeaders,
  streamingResponse,
} from "./http.ts";
import { transformChatRequest } from "./transforms/chat.ts";
import { transformImageRequest } from "./transforms/images.ts";
import { transformVideoRequest } from "./transforms/videos.ts";
import type {
  GatewayConfig,
  GatewayOptions,
  JsonObject,
  ResponseContext,
} from "./types.ts";

const MAX_VIDEO_METADATA_BYTES = 2 * 1024 * 1024;

/**
 * Runtime-independent implementation of the public gateway endpoints.
 *
 * Fresh route modules below are intentionally tiny adapters around this
 * class. Tests and other Deno servers can inject `fetch` and invoke handlers
 * directly, which keeps all protocol behavior reusable and deterministic.
 */
export class AgnesOpenAIGateway {
  readonly config: GatewayConfig;
  private readonly client: AgnesClient;

  constructor(options: GatewayOptions = {}) {
    this.config = resolveGatewayConfig(options);
    this.client = new AgnesClient(
      this.config,
      options.fetch ?? globalThis.fetch.bind(globalThis),
    );
  }

  handleOptions(): Response {
    return preflightResponse();
  }

  handleChatCompletions(request: Request): Promise<Response> {
    return this.handle(request, async (context) => {
      const authorization = requireBearerAuthorization(request);
      const input = await parseJsonRequest(
        request,
        this.config.maxRequestBytes,
      );
      const transformed = transformChatRequest(
        input,
        context.ignoredParams as Set<string>,
      );
      addIgnored(context, transformed.ignored);

      const upstream = await this.client.request(
        "chat/completions",
        authorization,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: transformed.stream
              ? "text/event-stream"
              : "application/json",
          },
          body: JSON.stringify(transformed.body),
          signal: request.signal,
        },
        { detachInboundSignalAfterHeaders: true },
      );
      await ensureUpstreamOk(upstream);
      return streamingResponse(upstream, context);
    });
  }

  handleImageGenerations(request: Request): Promise<Response> {
    return this.handle(request, async (context) => {
      const authorization = requireBearerAuthorization(request);
      const input = await parseJsonRequest(
        request,
        this.config.maxRequestBytes,
      );
      const transformed = transformImageRequest(input, "generation");
      addIgnored(context, transformed.ignored);
      return await this.executeImages(
        transformed.body,
        transformed.n,
        authorization,
        context,
        request.signal,
      );
    });
  }

  handleImageEdits(request: Request): Promise<Response> {
    return this.handle(request, async (context) => {
      const authorization = requireBearerAuthorization(request);
      const contentType = request.headers.get("content-type")?.toLowerCase() ??
        "";
      let input: JsonObject;
      let images: string[];
      let standardImagesProvided = false;

      if (contentType.includes("multipart/form-data")) {
        const form = await parseMultipartRequest(
          request,
          this.config.maxRequestBytes,
        );
        const parsed = parseFormFields(form, this.config);
        input = parsed.fields;
        images = await multipartEditImages(parsed);
        standardImagesProvided =
          (parsed.entries.get("image")?.length ?? 0) > 0 ||
          (parsed.entries.get("image[]")?.length ?? 0) > 0 ||
          input.images !== undefined;
        for (const field of parsed.entries.keys()) {
          if (!IMAGE_EDIT_MULTIPART_FIELDS.has(field)) {
            addIgnored(context, [field]);
          }
        }
      } else {
        input = await parseJsonRequest(request, this.config.maxRequestBytes);
        const normalized = jsonEditImages(input);
        images = normalized.references;
        addIgnored(context, normalized.ignored);
        standardImagesProvided = input.image !== undefined ||
          input.images !== undefined;
      }

      if (images.length > this.config.maxImageFiles) {
        throw new GatewayError(
          413,
          `Image edits support at most ${this.config.maxImageFiles} input images.`,
          { param: "image", code: "too_many_files" },
        );
      }
      const transformed = transformImageRequest(
        input,
        "edit",
        images,
        standardImagesProvided,
      );
      addIgnored(context, transformed.ignored);
      return await this.executeImages(
        transformed.body,
        transformed.n,
        authorization,
        context,
        request.signal,
      );
    });
  }

  handleVideoGeneration(request: Request): Promise<Response> {
    return this.handle(request, async (context) => {
      const authorization = requireBearerAuthorization(request);
      const contentType = request.headers.get("content-type")?.toLowerCase() ??
        "";
      let input: JsonObject;
      let inputReference: string | undefined;
      let multipartReferenceProvided = false;

      if (contentType.includes("multipart/form-data")) {
        const form = await parseMultipartRequest(
          request,
          this.config.maxRequestBytes,
        );
        const parsed = parseFormFields(form, this.config);
        input = parsed.fields;
        const reference = await multipartVideoReference(parsed);
        inputReference = reference.reference;
        multipartReferenceProvided = reference.provided;
        addIgnored(context, reference.ignored);
        for (const field of parsed.entries.keys()) {
          if (!VIDEO_MULTIPART_FIELDS.has(field)) addIgnored(context, [field]);
        }
      } else {
        input = await parseJsonRequest(request, this.config.maxRequestBytes);
      }

      const transformed = transformVideoRequest(
        input,
        inputReference,
        multipartReferenceProvided,
      );
      addIgnored(context, transformed.ignored);
      const upstream = await this.client.request("videos", authorization, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(transformed.body),
        signal: request.signal,
      });
      await ensureUpstreamOk(upstream);
      const metadata = normalizeVideoMetadata(
        await readUpstreamJson(upstream, MAX_VIDEO_METADATA_BYTES),
      );
      return jsonResponse(
        metadata,
        upstream.status,
        context,
        safeUpstreamHeaders(upstream.headers),
      );
    });
  }

  handleVideoRetrieval(request: Request, videoId: string): Promise<Response> {
    return this.handle(request, async (context) => {
      const authorization = requireBearerAuthorization(request);
      validateVideoId(videoId);
      const upstream = await this.requestVideoMetadata(
        videoId,
        authorization,
        request.signal,
      );
      await ensureUpstreamOk(upstream);
      const metadata = normalizeVideoMetadata(
        await readUpstreamJson(upstream, MAX_VIDEO_METADATA_BYTES),
      );
      return jsonResponse(
        metadata,
        upstream.status,
        context,
        safeUpstreamHeaders(upstream.headers),
      );
    });
  }

  handleVideoContent(request: Request, videoId: string): Promise<Response> {
    return this.handle(request, async (context) => {
      const authorization = requireBearerAuthorization(request);
      validateVideoId(videoId);
      const requestUrl = new URL(request.url);
      for (const [name, value] of requestUrl.searchParams) {
        if (name !== "variant" || value !== "video") {
          addIgnored(context, [name]);
        }
      }

      const metadataResponse = await this.requestVideoMetadata(
        videoId,
        authorization,
        request.signal,
      );
      await ensureUpstreamOk(metadataResponse);
      const metadata = await readUpstreamJson(
        metadataResponse,
        MAX_VIDEO_METADATA_BYTES,
      );
      const status = typeof metadata.status === "string"
        ? metadata.status.toLowerCase()
        : "";
      if (status !== "completed" && status !== "succeeded") {
        const failed = status === "failed";
        throw new GatewayError(
          409,
          failed
            ? "The Agnes video generation task failed."
            : "The generated video is not ready for download.",
          {
            type: "invalid_request_error",
            param: "video_id",
            code: failed ? "video_generation_failed" : "video_not_ready",
          },
        );
      }

      const mediaUrl = findVideoUrl(metadata);
      if (!mediaUrl) {
        throw new GatewayError(
          502,
          "Agnes marked the video complete but did not return a media URL.",
          { code: "invalid_upstream_response" },
        );
      }

      const media = await this.client.requestMedia(
        mediaUrl,
        request.headers.get("range"),
        request.signal,
      );
      if (!media.ok && media.status !== 206) {
        if (media.body) await media.body.cancel();
        const headers = safeUpstreamHeaders(media.headers);
        const contentRange = media.headers.get("content-range");
        if (contentRange) headers.set("content-range", contentRange);
        throw new GatewayError(
          media.status >= 400 && media.status <= 599 ? media.status : 502,
          `Generated video download failed with status ${media.status}.`,
          { code: "media_download_failed", headers },
        );
      }
      return streamingResponse(media, context, { media: true });
    });
  }

  /**
   * Query the documented video-ID endpoint without storing an ID map.
   *
   * Gateways released before the live contract check exposed Agnes task IDs as
   * their public IDs. A bounded read-only fallback on 400/404 keeps those IDs
   * usable while all newly-created responses prefer the documented video ID.
   */
  private async requestVideoMetadata(
    videoId: string,
    authorization: string,
    signal: AbortSignal,
  ): Promise<Response> {
    const recommended = await this.client.requestApiRoot(
      `agnesapi?video_id=${encodeURIComponent(videoId)}`,
      authorization,
      { signal },
    );
    if (
      recommended.ok ||
      (recommended.status !== 400 && recommended.status !== 404)
    ) {
      return recommended;
    }

    await cancelResponseBody(recommended);
    return await this.client.request(
      `videos/${encodeURIComponent(videoId)}`,
      authorization,
      { signal },
    );
  }

  private async executeImages(
    body: JsonObject,
    n: number,
    authorization: string,
    context: ResponseContext,
    signal: AbortSignal,
  ): Promise<Response> {
    const serialized = JSON.stringify(body);
    // Fan out immediately and wait for all requests. There is deliberately no
    // retry: one failure makes the OpenAI `n` request fail atomically.
    const settled = await Promise.allSettled(
      Array.from(
        { length: n },
        () =>
          this.client.request("images/generations", authorization, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              accept: "application/json",
            },
            body: serialized,
            signal,
          }),
      ),
    );

    const rejected = settled.find((result) => result.status === "rejected");
    if (rejected?.status === "rejected") {
      await cancelResponses(settled);
      throw rejected.reason;
    }
    const responses = settled.map((result) =>
      (result as PromiseFulfilledResult<Response>).value
    );

    const failureIndex = responses.findIndex((response) => !response.ok);
    if (failureIndex >= 0) {
      for (const [index, response] of responses.entries()) {
        if (index !== failureIndex) await cancelResponseBody(response);
      }
      await ensureUpstreamOk(responses[failureIndex]);
    }

    let remaining = this.config.maxImageResponseBytes;
    const payloads: JsonObject[] = [];
    try {
      for (const response of responses) {
        if (!response.body) {
          throw invalidImageResponse("Agnes returned an empty image response.");
        }
        const bytes = await readStreamBytes(
          response.body,
          remaining,
          () =>
            new GatewayError(
              502,
              `Aggregated image response exceeds the ${this.config.maxImageResponseBytes}-byte gateway limit.`,
              { code: "image_response_too_large" },
            ),
        );
        remaining -= bytes.byteLength;
        let parsed: unknown;
        try {
          parsed = JSON.parse(new TextDecoder().decode(bytes));
        } catch {
          throw invalidImageResponse(
            "Agnes returned invalid JSON for an image request.",
          );
        }
        if (!isJsonObject(parsed) || !Array.isArray(parsed.data)) {
          throw invalidImageResponse(
            "Agnes returned an invalid image response shape.",
          );
        }
        payloads.push(parsed);
      }
    } catch (error) {
      // Some fan-out bodies may not have been consumed yet. Always release
      // them, but never let a cancellation failure replace the real protocol
      // or size error returned to the caller.
      await Promise.all(responses.map(cancelResponseBody));
      throw error;
    }

    const first = payloads[0];
    const data = payloads.flatMap((payload) => payload.data as unknown[]);
    return jsonResponse(
      { ...first, data },
      responses[0].status,
      context,
      safeUpstreamHeaders(responses[0].headers),
    );
  }

  private async handle(
    request: Request,
    operation: (context: ResponseContext) => Promise<Response>,
  ): Promise<Response> {
    const ignored = new Set<string>();
    const context: ResponseContext = {
      requestId: getRequestId(request),
      ignoredParams: ignored,
    };
    try {
      return await operation(context);
    } catch (error) {
      const normalized = request.signal.aborted &&
          !(error instanceof GatewayError)
        ? new GatewayError(499, "The API request was cancelled.", {
          type: "request_error",
          code: "request_cancelled",
        })
        : error;
      return errorResponse(normalized, context);
    }
  }
}

const IMAGE_EDIT_MULTIPART_FIELDS = new Set([
  "model",
  "prompt",
  "image",
  "image[]",
  "images",
  "size",
  "n",
  "response_format",
  "ratio",
  "return_base64",
  "extra_body",
]);

const VIDEO_MULTIPART_FIELDS = new Set([
  "model",
  "prompt",
  "seconds",
  "size",
  "input_reference",
  "input_reference[image_url]",
  "input_reference[file_id]",
  "image",
  "mode",
  "height",
  "width",
  "num_frames",
  "frame_rate",
  "num_inference_steps",
  "seed",
  "negative_prompt",
  "extra_body",
]);

function addIgnored(context: ResponseContext, names: Iterable<string>): void {
  const target = context.ignoredParams as Set<string>;
  for (const name of names) target.add(name);
}

async function cancelResponses(
  settled: PromiseSettledResult<Response>[],
): Promise<void> {
  await Promise.all(
    settled.map((result) =>
      result.status === "fulfilled"
        ? cancelResponseBody(result.value)
        : Promise.resolve()
    ),
  );
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel("image fan-out aborted");
  } catch {
    // The body may already be consumed, locked, or closed. Cleanup is best
    // effort and must not hide the primary upstream failure.
  }
}

function invalidImageResponse(message: string): GatewayError {
  return new GatewayError(502, message, { code: "invalid_upstream_response" });
}

async function readUpstreamJson(
  response: Response,
  maxBytes: number,
): Promise<JsonObject> {
  if (!response.body) {
    throw new GatewayError(502, "Agnes returned an empty response.", {
      code: "invalid_upstream_response",
    });
  }
  const bytes = await readStreamBytes(
    response.body,
    maxBytes,
    () =>
      new GatewayError(502, "Agnes metadata response is too large.", {
        code: "invalid_upstream_response",
      }),
  );
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (isJsonObject(value)) return value;
  } catch {
    // Fall through to the common safe error below.
  }
  throw new GatewayError(502, "Agnes returned invalid JSON metadata.", {
    code: "invalid_upstream_response",
  });
}

function normalizeVideoMetadata(input: JsonObject): JsonObject {
  const id = typeof input.video_id === "string" && input.video_id
    ? input.video_id
    : typeof input.id === "string" && input.id
    ? input.id
    : typeof input.task_id === "string" && input.task_id
    ? input.task_id
    : null;
  // Prefer video_id so the public ID is directly retrievable through Agnes's
  // documented stateless query endpoint. Keep task_id and the original fields
  // as Agnes extensions for diagnostics and backward compatibility.
  return id && input.id !== id ? { ...input, id } : input;
}

function findVideoUrl(metadata: JsonObject): string | null {
  for (const candidate of [metadata.url, metadata.output_url]) {
    if (typeof candidate === "string" && candidate) return candidate;
  }
  for (const key of ["data", "video", "output"]) {
    const nested = metadata[key];
    if (isJsonObject(nested) && typeof nested.url === "string" && nested.url) {
      return nested.url;
    }
  }
  return null;
}

function validateVideoId(videoId: string): void {
  if (!videoId || videoId.length > 512) {
    throw new GatewayError(400, "'video_id' is invalid.", {
      param: "video_id",
      code: "invalid_video_id",
    });
  }
}

/** Create a gateway instance, optionally injecting an upstream fetch function. */
export function createGateway(
  options: GatewayOptions = {},
): AgnesOpenAIGateway {
  return new AgnesOpenAIGateway(options);
}
