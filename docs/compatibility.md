# Compatibility reference

[简体中文](compatibility.zh-CN.md)

Research baseline: **2026-09-18**. This document describes the gateway's
intentional public contract. It is based on the Agnes documentation for
[chat](https://agnes-ai.com/zh-Hans/docs/agnes-30-flash.md),
[images](https://agnes-ai.com/zh-Hans/docs/agnes-image-25-flash.md),
[video 2.5](https://agnes-ai.com/zh-Hans/docs/agnes-video-25-flash.md), and
[video V2.0](https://agnes-ai.com/zh-Hans/docs/agnes-video-v20.md), and the
current OpenAI HTTP references for
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

| Classification  | Fields and behavior                                                                                                                                                                                                                                 |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pass-through    | `model`, `temperature`, `top_p`, `max_tokens`, and `stream`                                                                                                                                                                                         |
| Translated      | `max_completion_tokens` → `max_tokens`; `developer` message role → `system`; every message is rebuilt from only documented fields                                                                                                                   |
| Partial         | Message roles are limited to `system`, `user`, `assistant`, and `tool`. Content may be a string or an array of `text` and public `image_url` blocks. Unsupported blocks in a mixed array are dropped; an array with no usable blocks returns `400`. |
| Translated      | Assistant `tool_calls` and `tool_call_id` tool-result messages complete the OpenAI function-calling round trip documented for Agnes 3.0 Flash. `content` may be `null` on an assistant message that carries tool calls.                             |
| Agnes extension | `chat_template_kwargs` and `thinking`                                                                                                                                                                                                               |
| Ignored         | Unknown top-level controls and unknown nested message/content-block/tool-call fields are removed and reported by full path. This includes message `name`, audio, refusal, metadata, and image detail fields.                                        |
| Rejected        | Any other undocumented role, a `tool` message without `tool_call_id`, missing content on non-tool-assistant messages, or content with an invalid shape returns `400`; the gateway does not invent a substitute message.                             |

If both `max_completion_tokens` and `max_tokens` are present,
`max_completion_tokens` takes precedence. SSE responses are forwarded as a
backpressured byte stream, including the upstream `[DONE]` marker. The gateway
does not synthesize usage chunks or reinterpret tool-call output. Tool calls are
forwarded for the caller to execute; the validated OpenAI continuation fields
are then accepted on the next request.

## Image generations

`POST /v1/images/generations`

| Classification  | Fields and behavior                                                                                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Pass-through    | `model`, `prompt`, and a caller-supplied `size`                                                                                                                                      |
| Translated      | Missing `size` → `1024x1024`; generation `response_format: url` or `response_format: b64_json` → Agnes `extra_body.response_format`                                                  |
| Translated      | `n` (`1`–`10`) → that many concurrent Agnes requests, with upstream `n` removed; results retain request order                                                                        |
| Partial         | Exact pixel dimensions can be normalized by Agnes to a supported size tier/ratio. Returned metadata is authoritative.                                                                |
| Agnes extension | `ratio`, `return_base64`, and the documented `extra_body.image`/`extra_body.response_format` controls. Unknown `extra_body` members are extension pass-through and are not portable. |
| Ignored         | Unsupported OpenAI controls such as `background`, `quality`, `style`, `moderation`, `output_compression`, `partial_images`, `stream`, and `user`                                     |

Fan-out is atomic: if any upstream request fails, the gateway returns one error
and no partial `data` array. It does not retry successful or failed branches.
The aggregate response is capped at 64 MiB.

`return_base64` is accepted only as a direct Agnes extension when the standard
`response_format` is absent. A live probe observed Agnes accept that documented
control while returning a URL, so the standard `b64_json` mapping instead uses
the verified `extra_body.response_format`. If `response_format` is supplied, it
always wins: the gateway removes `return_base64` and any conflicting extension
format, then reports each removed path even when its value agrees.

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

### Video 2.5 and 2.5 Flash

Models matching `agnes-video-2.5*` are translated to the documented OpenAI
Videos-compatible 2.5 contract instead of the V2.0 frame dialect. V2.0 model
names keep the behavior described above unchanged.

| Classification  | Fields and behavior                                                                                                                                                                                                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pass-through    | `model`, `prompt`, and `seed`                                                                                                                                                                                                                                                               |
| Translated      | `seconds` accepts a number or numeric string from `4` to `12`, defaults to `4`, and is always sent as a string because the upstream rejects JSON numbers                                                                                                                                    |
| Translated      | `size` accepts the `720P`, `1080P`, `1K`, and `2K` tiers. The OpenAI pixel sizes map to `720P` plus a ratio (`720x1280`/`1024x1792` → `9:16`, `1280x720`/`1792x1024` → `16:9`); omitting `size` keeps the OpenAI portrait default `720x1280` → `720P`/`9:16`                                |
| Translated      | `aspect_ratio` defaults to `16:9` for an explicit tier size and is overridden (and reported) when a pixel `size` implies a different ratio. Only `21:9`, `16:9`, `4:3`, `1:1`, `3:4`, and `9:16` are accepted                                                                               |
| Translated      | `mode` defaults to `keyframe` when `input_reference`, `first_frame`, `last_frame`, or `image` is present, to `reference` when `images`, `audios`, or `videos` is present, and to `text` otherwise. `ti2vid`/`keyframes`/`i2vid` map to `keyframe` and `multi_reference` maps to `reference` |
| Translated      | JSON or multipart `input_reference`, and the Agnes `image` extension, become `first_frame`; `last_frame`, `images`, `audios`, and `videos` pass through at the top level                                                                                                                    |
| Agnes extension | `extra_body` members are hoisted to the top level for this dialect; top-level values win and every hoisted conflict or unknown member is reported                                                                                                                                           |
| Enforced        | `agnes-video-2.5-flash` requires `size: 720P`, at most 5 `images`, at most 3 `audios`, and no `videos` content; violations return `400` before any upstream work                                                                                                                            |
| Partial         | `num_frames`, `frame_rate`, `width`, `height`, `num_inference_steps`, and `negative_prompt` have no 2.5 equivalent and are reported as ignored                                                                                                                                              |

## Video retrieval and content

`GET /v1/videos/{video_id}` treats the public path value as the Agnes `video_id`
returned by creation and queries the documented stateless `/agnesapi?video_id=…`
endpoint. Creation therefore exposes `video_id` as the OpenAI-style `id`, while
retaining Agnes `task_id` as an extension. A 400/404 from the recommended
endpoint triggers one read-only request to the legacy `/videos/{task_id}` route
so task IDs returned by older gateway versions remain usable. No ID map or
database is required.

Video 2.5 and 2.5 Flash only resolve with an exact `model_name`, which a
stateless gateway cannot infer from a bare video ID. Their creation responses
therefore expose `id` as `<model>:<video_id>` (for example
`agnes-video-2.5-flash:task_…`) and retrieval splits that prefix back into the
`model_name` query parameter. The original `video_id` field is unchanged, and
V2.0 responses keep `id == video_id`. A model-bound ID never takes the legacy
fallback because that route only serves V2.0 task IDs.

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

- Agnes does not currently document the exact Chat SSE chunk schema or a stable
  error body. Gated live probes can investigate those upstream shapes, but do
  not make them part of the gateway contract; the gateway never invents
  undocumented data. The OpenAI tool-call and tool-result message shape is
  verified against `agnes-3.0-flash` and is covered by the gated live probe.
- Agnes image documentation describes input images at two locations; the working
  compatibility contract intentionally sends them at `extra_body.image`. Base64
  output also differs between text-to-image and image-to-image requests.
- Agnes documents both a recommended `/agnesapi?video_id=…` query and a legacy
  `/v1/videos/{task_id}` query. Live testing found that a newly-created task was
  rejected by the legacy route, so the gateway exposes `video_id` as its public
  ID and uses the recommended route. A bounded legacy fallback preserves old
  gateway IDs without an ID map or database.
- Video 2.5 and 2.5 Flash reject the V2.0 frame fields and return `404` from the
  stateless query when `model_name` is missing or does not exactly match the
  creation model, so their public IDs embed that model.
- Image generation may take 60–360 seconds. Deno Deploy can recycle instances
  and multipart parsing is memory-bound; use Docker for workloads that exceed
  the limits of a selected Deno Deploy plan.
- The gateway does not impose account quotas, but Agnes or the hosting platform
  can still return `429`, size limits, or timeouts.

See [contract testing](contract-testing.md) for the opt-in live verification
process. A successful mocked test does not claim that an undocumented Agnes
shape has been verified.

Dated, redacted upstream observations are recorded separately. The
[M2 evidence](contract-results/2026-07-18-m2.md) confirms Chat, error, and Image
URL and Data-URI image-edit envelopes. It also records that documented
`return_base64` requests returned URLs while the gateway's verified
`extra_body.response_format: b64_json` mapping returned Base64. After two
transient `503` responses, the formal committed scope also passed with that
mapping, completing M2 contract acceptance. The latest
[M3 evidence](contract-results/2026-07-18-m3.md) confirms real video creation,
video-ID terminal polling, completed media resolution, and byte-range download.
The
[Agnes 3.0 Flash family evidence](contract-results/2026-09-18-agnes-3-flash-family.md)
confirms the Chat tool round trip, Image 2.5 generation and editing, and the
Video 2.5 Flash create/retrieve/content flow with model-qualified polling.
