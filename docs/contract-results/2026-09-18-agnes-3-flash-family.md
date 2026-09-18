# Agnes 3.0 Flash family adaptation evidence — 2026-09-18

[简体中文](2026-09-18-agnes-3-flash-family.zh-CN.md)

Status: **accepted**.

This record contains only bounded status and structure observations. It omits
credentials, prompts, task IDs, response values, media URLs, Data URIs, and
media bytes.

## Run metadata

| Item                | Value                                                               |
| ------------------- | ------------------------------------------------------------------- |
| Gateway revision    | Working tree built from `68d450a1e52647eae047c823d518937338d37515`  |
| Deno                | `2.9.6`                                                             |
| Configured API host | Caller-operated HTTPS reverse proxy to Agnes (host redacted)         |
| Models under test   | `agnes-3.0-flash`, `agnes-image-2.5-flash`, `agnes-video-2.5-flash` |
| Input               | Repository-owned synthetic PNG Data URIs and fixed probe prompts    |
| Retry policy        | Creations never retried; only idempotent retrieval repeated         |
| Credential          | Disposable caller key loaded only into the opt-in live-test process |

## Test cases

### Offline suite (committed, deterministic)

| Area                  | Cases | What is verified                                                                                                                                                            |
| --------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chat tool round trip  | 3     | Assistant `tool_calls` with `content: null` is rebuilt from documented fields; `tool` result messages require `tool_call_id`; malformed continuations return `400` locally. |
| Chat compatibility    | 6     | `developer`→`system`, `max_completion_tokens` precedence, content blocks, ignored-path reporting, SSE byte passthrough.                                                     |
| Video 2.5 translation | 8     | `seconds` string coercion, tier/pixel `size` mapping, `aspect_ratio` precedence, mode defaults and aliases, keyframe/reference media, `extra_body` hoisting, Flash limits.  |
| Video retrieval       | 5     | Model-qualified `model_name` query, no legacy fallback for 2.5 IDs, `metadata.url` content resolution, V2.0 ID behavior, legacy fallback.                                   |
| Video V2.0 regression | 5     | Frame-based `num_frames`/`frame_rate`/`width`/`height` mapping and multipart reference handling remain unchanged.                                                           |
| Images                | 9     | Generation/edit mapping, `n` fan-out, Base64 precedence, multipart Data URIs, size limits.                                                                                  |
| Official OpenAI SDK   | 1     | `videos.create`/`retrieve`/`downloadContent` for V2.0 and 2.5 (including the model-bound public ID) over real HTTP.                                                         |
| OpenAPI document      | 1     | The checked-in contract parses and describes exactly the public routes.                                                                                                     |
| Fresh route adapters  | 3     | Health, CORS preflight, and OpenAI-shaped 404/405 middleware.                                                                                                               |

### Gated live probes (`tests/live_contract.ts`)

| Probe      | Scope                                 | Result                                                                                                                  |
| ---------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Chat       | `chat`                                | `200`; OpenAI-compatible envelope from `agnes-3.0-flash`.                                                               |
| Chat SSE   | `chat-sse`                            | `200`; expected SSE chunk shape.                                                                                        |
| Chat tools | `chat-tools`                          | `200` for both the tool-call and the tool-result request; the assistant `tool_calls` continuation is accepted upstream. |
| Errors     | `errors`                              | `400` and `401` safe OpenAI-shaped error envelopes.                                                                     |
| Images     | `image`, `image-base64`, `image-edit` | `200`; URL, Base64, and Data-URI edit envelopes from `agnes-image-2.5-flash`.                                           |
| Video      | `video`                               | `200`; creation envelope, then `200` retrieval by `video_id` with `model_name=agnes-video-2.5-flash`.                   |

### Gateway end-to-end (`deno task build` + `deno serve`, real key)

| Workflow       | Request                                                        | Result                                                                                                     |
| -------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Chat           | `agnes-3.0-flash`, single user message                         | `200`; `finish_reason: stop`.                                                                              |
| Chat tools     | Tool call, then assistant `tool_calls` + `tool` result         | `200`; `finish_reason: tool_calls` followed by `finish_reason: stop` and a tool-informed answer.           |
| Image generate | `agnes-image-2.5-flash`, `size: 2K`, `ratio: 16:9`, URL output | `200`; one URL result.                                                                                     |
| Image edit     | Data-URI `images` + `response_format: b64_json`                | `200`; one Base64 result.                                                                                  |
| Video create   | `agnes-video-2.5-flash`, `720P`, `9:16`, keyframe Data URI     | `200`; public `id` was `agnes-video-2.5-flash:<task>` and the original `video_id` was preserved.           |
| Video retrieve | Encoded model-bound public `id`                                | `200`; reached `completed` with `progress: 100`.                                                           |
| Video content  | `Range: bytes=0-0` on the same ID                              | `206`; `content-range: bytes 0-0/<size>`, `content-type: video/mp4`, one byte returned.                    |
| Flash limits   | `size: 1080P`, `seconds: 13`, 6 images, 4 audios, `videos`     | `400` for each, with `param` set to `size`, `seconds`, `images`, `audios`, and `videos`; no upstream call. |

## Upstream observations that shaped the implementation

| Observation                                                                                          | Evidence                                                               | Resulting behavior                                                       |
| ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Video 2.5 rejects the V2.0 frame contract; `height` is a forbidden field and pixel sizes are invalid | `invalid_request` with `param: height`, and `size must be one of 720P` | Model-family dialect dispatch in the video transform.                    |
| The stateless query returns `404` unless `model_name` exactly matches the creation model             | Retrieval failed with every other model string                         | 2.5 public IDs embed the model and retrieval sends `model_name`.         |
| `seconds` must be a JSON string for 2.5                                                              | Numeric `seconds` failed request parsing                               | 2.5 always sends the string form.                                        |
| Keyframe reference images must be at least 256 px per side                                           | `input image side length must be between 256 and 5760 pixels`          | Probes use a 256 px synthetic PNG.                                       |
| Video creation can answer `503`/`video_queue_full` transiently                                       | Multiple creation attempts during the run                              | Callers see the upstream status; the gateway never retries a creation.   |
| A completed 2.5 Flash task reports the media URL at the top level in this run                        | Completed retrieval payload keys                                       | The gateway resolves both top-level `url` and documented `metadata.url`. |

## Verification commands

```bash
deno task check          # fmt + lint + type-check + test discovery
deno task test           # 53 passed, 0 failed
RUN_AGNES_LIVE_TESTS=1 AGNES_LIVE_SCOPES=chat,chat-sse,chat-tools,errors,image,image-base64,image-edit deno task test:live
RUN_AGNES_LIVE_TESTS=1 AGNES_LIVE_SCOPES=video deno task test:live
```

The Chromium browser smoke suite was not run locally because no Chromium binary
is installed in this environment; the landing-page default-model change is
covered by the existing CI job.

## Limitations

- Live results depend on Agnes account permissions, current promotional
  availability, and queue capacity observed on 2026-09-18.
- The 2.5 completed payload was observed with a top-level `url`; the documented
  `metadata.url` form is also accepted, but only the top-level form was seen in
  this run.
- `agnes-video-v2.0` remains supported by the unchanged V2.0 dialect, but it was
  not re-run end to end in this adaptation; its unit tests still pass.
