# Compatibility reference

[简体中文](compatibility.zh-CN.md)

Research baseline: **2026-07-16**. This document describes the gateway's
intentional public contract. It is based on the Agnes documentation for
[chat](https://agnes-ai.com/zh-Hans/docs/agnes-20-flash.md),
[images](https://agnes-ai.com/zh-Hans/docs/agnes-image-21-flash.md), and
[video](https://agnes-ai.com/zh-Hans/docs/agnes-video-v20.md), and the current
OpenAI HTTP references for
[Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create),
[Images](https://developers.openai.com/api/reference/resources/images/methods/generate),
and
[Videos](https://developers.openai.com/api/reference/resources/videos/methods/create).

The gateway does not map model names. Examples use the models documented by
Agnes, but any `model` value is sent unchanged.

## Classification

| Label           | Meaning                                                                                |
| --------------- | -------------------------------------------------------------------------------------- |
| Pass-through    | Validated enough to route safely, then sent without semantic conversion                |
| Translated      | Converted between OpenAI and Agnes names or structures                                 |
| Ignored         | Removed before the upstream call and named in `X-Agnes-Gateway-Ignored-Params`         |
| Partial         | The common shape works, but one side cannot provide full semantics                     |
| Agnes extension | Accepted for Agnes-specific control; not portable to other OpenAI-compatible APIs      |
| Rejected        | Unsupported input that cannot be represented safely and returns an OpenAI-shaped `400` |

Unknown optional fields are ignored when the remaining request is valid.
Missing/invalid required data still returns `400`. When a standard OpenAI field
and an Agnes extension control the same value, the OpenAI field wins and the
overridden path is reported as ignored.

## Common behavior

- Every `/v1/*` operation requires `Authorization: Bearer <Agnes API key>`. The
  key is never read from a production environment variable or persisted.
- `model` is required for create/generate calls and passed unchanged. Retrieval
  uses the task identity returned at creation time.
- JSON errors have the OpenAI-shaped `error.message`, `error.type`,
  `error.param`, and `error.code` fields. Safe upstream status codes,
  `Retry-After`, and request IDs are preserved where available.
- There are no gateway retries. This matters for paid or nondeterministic
  generations: one client request never silently creates a replacement task.
- Waiting for upstream response headers is capped at 360 seconds. A client
  disconnect before headers cancels the upstream fetch; after headers, SSE and
  media cancellation propagates through the streamed response body.
- CORS allows any origin and the `Accept`, `Authorization`, `Content-Type`,
  `Range`, and `X-Request-ID` request headers, but never allows browser cookie
  credentials.
- Ignored-parameter metadata contains at most 32 safe paths of at most 128
  characters each. Unsafe names become `<redacted>` and overflow is represented
  by `<truncated>`, so arbitrary JSON keys cannot leak into or amplify headers.

## Chat completions

`POST /v1/chat/completions`

| Classification  | Fields and behavior                                                                                                                                                                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pass-through    | `model`, `temperature`, `top_p`, `max_tokens`, and `stream`                                                                                                                                                                                                   |
| Translated      | `max_completion_tokens` → `max_tokens`; `developer` message role → `system`; every message is rebuilt from only `role` and `content`                                                                                                                          |
| Partial         | Message roles are limited to `system`, `user`, and `assistant` after translation. Content may be a string or an array of `text` and public `image_url` blocks. Unsupported blocks in a mixed array are dropped; an array with no usable blocks returns `400`. |
| Partial         | Top-level `tools` and `tool_choice` are forwarded after container-type validation. Agnes documents tool requests, but the gateway cannot complete an OpenAI tool-result round trip because tool messages are unsupported.                                     |
| Agnes extension | `chat_template_kwargs` and `thinking`                                                                                                                                                                                                                         |
| Ignored         | Unknown top-level controls and unknown nested message/content-block fields are removed and reported by full path. This includes message `name`, `tool_calls`, `tool_call_id`, audio, refusal, metadata, and image detail fields.                              |
| Rejected        | A `tool` role/tool-result message, any other undocumented role, missing `content`, or content with an invalid shape returns `400`; the gateway does not invent a substitute message.                                                                          |

If both `max_completion_tokens` and `max_tokens` are present,
`max_completion_tokens` takes precedence. SSE responses are forwarded as a
backpressured byte stream, including the upstream `[DONE]` marker. The gateway
does not synthesize usage chunks or reinterpret tool-call output. Because only
Agnes-documented message fields are sent upstream, callers should execute tool
calls outside this endpoint until Agnes documents and the gateway implements a
tool-result message contract.

## Image generations

`POST /v1/images/generations`

| Classification  | Fields and behavior                                                                                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Pass-through    | `model`, `prompt`, and a caller-supplied `size`                                                                                                                                      |
| Translated      | Missing `size` → `1024x1024`; generation `response_format: url` → Agnes `extra_body.response_format: url`                                                                            |
| Partial         | Generation `response_format: b64_json` → documented Agnes `return_base64: true`; the 2026-07-18 live result did not yet confirm a stable `b64_json` response                         |
| Translated      | `n` (`1`–`10`) → that many concurrent Agnes requests, with upstream `n` removed; results retain request order                                                                        |
| Partial         | Exact pixel dimensions can be normalized by Agnes to a supported size tier/ratio. Returned metadata is authoritative.                                                                |
| Agnes extension | `ratio`, `return_base64`, and the documented `extra_body.image`/`extra_body.response_format` controls. Unknown `extra_body` members are extension pass-through and are not portable. |
| Ignored         | Unsupported OpenAI controls such as `background`, `quality`, `style`, `moderation`, `output_compression`, `partial_images`, `stream`, and `user`                                     |

Fan-out is atomic: if any upstream request fails, the gateway returns one error
and no partial `data` array. It does not retry successful or failed branches.
The aggregate response is capped at 64 MiB.

`return_base64` is accepted only as a direct Agnes extension when the standard
`response_format` is absent. If `response_format` is supplied, it always wins:
the gateway removes `return_base64` and any conflicting
`extra_body.response_format`, then reports each removed path even when its value
agrees. Portable OpenAI clients should therefore prefer `response_format`.

## Image edits

`POST /v1/images/edits`

| Classification          | Fields and behavior                                                                                                                                      |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Accepted inputs         | `multipart/form-data` with repeated `image` or `image[]` files; JSON with `images`/`image` URL or Data URI values                                        |
| Translated              | Uploaded files → Data URIs; all inputs → Agnes `extra_body.image`; the upstream endpoint is `/images/generations`                                        |
| Shared with generations | `model`, `prompt`, `size`, `response_format`, `n`, `ratio`, and atomic fan-out rules; edit `response_format` always maps to `extra_body.response_format` |
| Partial                 | This is Agnes image-to-image generation, not pixel-accurate OpenAI mask editing. Composition preservation is model behavior.                             |
| Ignored                 | `mask` and OpenAI-only edit/output controls that Agnes cannot represent                                                                                  |

Uploads are processed in memory because the gateway is stateless. Limits are 20
MiB per file, 50 MiB total request size, and 16 images. Public URL inputs must
be fetchable by Agnes; use a Data URI when the source needs cookies or private
headers.

Standard `image`/`images` input overrides an Agnes `extra_body.image` extension,
and the overridden path is reported. JSON also accepts OpenAI-style reference
objects containing `image_url`; `file_id` is reported as ignored because this
stateless gateway cannot resolve OpenAI Files.

## Video creation

`POST /v1/videos`

| Classification  | Fields and behavior                                                                                                                                                     |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pass-through    | `model`, `prompt`                                                                                                                                                       |
| Translated      | `seconds` accepts OpenAI values `"4"`, `"8"`, or `"12"` (JSON numbers are tolerated), defaults to `4`, then maps to `frame_rate: 24` and `num_frames: seconds × 24 + 1` |
| Translated      | `size` accepts `720x1280`, `1280x720`, `1024x1792`, or `1792x1024`, defaults to `720x1280`, then splits into Agnes `width` and `height`                                 |
| Translated      | JSON or multipart `input_reference` → Agnes `image`; a multipart `input_reference` file becomes a Data URI                                                              |
| Agnes extension | `image`, `mode`, `seed`, `negative_prompt`, `num_inference_steps`, plus documented `extra_body.image` and `extra_body.mode` keyframe controls                           |
| Partial         | Agnes may normalize dimensions. Its `num_frames` must be `≤ 441` and match `8n + 1`; the response's `seconds` and `size` are authoritative.                             |
| Ignored         | OpenAI-only controls without an Agnes equivalent, reported in the ignored-params header                                                                                 |

OpenAI `seconds` and `size` (including their defaults) take precedence over
direct Agnes `num_frames`, `frame_rate`, `width`, and `height`; those four input
paths are reported as ignored. A standard `input_reference` similarly overrides
the Agnes `image` and `extra_body.image` controls. Video generation is
asynchronous; the creation call returns task metadata rather than media bytes.

## Video retrieval and content

`GET /v1/videos/{video_id}` treats the public path value as the Agnes
`task_id`/`id` returned by creation and queries Agnes's legacy
`/videos/{task_id}` endpoint. This choice keeps the gateway stateless. The Agnes
`video_id`, final `url`, progress, normalized size, and normalized duration
remain visible as extensions in the response.

`GET /v1/videos/{video_id}/content` first obtains current task state. Once a
successful task has a media URL, the gateway streams that URL with backpressure
and forwards a caller's `Range` request. It does not send the Agnes API key to a
different media-storage origin. Before completion, for a failed task, or when no
media URL exists, the endpoint returns an OpenAI-shaped error.

The OpenAI `variant=video|thumbnail|spritesheet` query is accepted for client
compatibility. Agnes exposes only the completed video URL, so `thumbnail` and
`spritesheet` cannot be generated by this lightweight gateway and currently
resolve to the video content.

## Response headers

| Header                             | Meaning                                                                                                          |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `X-Request-ID`                     | Gateway correlation ID; safe to include in a bug report                                                          |
| `X-Agnes-Gateway-Ignored-Params`   | Up to 32 safe, comma-separated paths; unsafe/oversized names become `<redacted>`, overflow becomes `<truncated>` |
| `Retry-After`                      | Preserved from a rate-limit/service response where available                                                     |
| `Cache-Control: private, no-store` | Prevents credential-derived JSON, SSE, URLs, and video bytes from entering shared or browser caches              |
| `Access-Control-Allow-Origin: *`   | Public non-cookie CORS policy                                                                                    |

## Known upstream gaps and deployment limits

- Agnes does not currently document the exact Chat SSE chunk schema, tool-result
  input messages, or a stable error body. Gated live probes can investigate
  those upstream shapes, but do not make them part of the gateway contract; the
  gateway never invents undocumented data.
- Agnes image documentation describes input images at two locations; the working
  compatibility contract intentionally sends them at `extra_body.image`. Base64
  output also differs between text-to-image and image-to-image requests.
- Agnes documents both a recommended `/agnesapi?video_id=…` query and a legacy
  `/v1/videos/{task_id}` query. The gateway uses the task-ID route so no ID map
  or database is required.
- Image generation may take 60–360 seconds. Deno Deploy can recycle instances
  and multipart parsing is memory-bound; use Docker for workloads that exceed
  the limits of a selected Deno Deploy plan.
- The gateway does not impose account quotas, but Agnes or the hosting platform
  can still return `429`, size limits, or timeouts.

See [contract testing](contract-testing.md) for the opt-in live verification
process. A successful mocked test does not claim that an undocumented Agnes
shape has been verified.

Dated, redacted upstream observations are recorded separately. The latest
[M2 evidence](contract-results/2026-07-18-m2.md) confirms Chat, error, and Image
URL and Data-URI image-edit envelopes. Text-to-image Base64 remains unresolved
after a successful response lacked a valid `b64_json` and later diagnostics
returned `503` and `504`.
