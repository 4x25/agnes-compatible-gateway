# Agnes Compatible Gateway MVP implementation plan

Last updated: 2026-07-12\
Specification snapshot: Agnes and OpenAI documentation as of 2026-07-10\
Target release: `v0.1.0`

Status legend: `[x]` implemented and verified locally; `[ ]` pending an external
action or acceptance gate.

## Feasibility and boundaries

The MVP is feasible as a stateless Deno/Fresh gateway. Agnes chat and image
responses are already close to OpenAI response shapes. Video creation and lookup
can remain stateless by exposing Agnes `video_id` as the OpenAI `id`.

Full OpenAI compatibility is intentionally not claimed:

- OpenAI file/file-ID video references cannot be converted to an Agnes HTTP(S)
  URL without storage. The MVP accepts syntactically valid URL references and
  leaves reachability to Agnes.
- Image edits use a documented project-specific JSON URL/Data URI subset rather
  than OpenAI multipart uploads.
- Agnes does not promise every OpenAI Video metadata field during lookup;
  unavailable fields are omitted instead of fabricated.
- Agnes does not document the complete SSE/error wire format, so a live preview
  smoke test remains a release gate.

## Fixed public contract

| Public endpoint                    | Accepted input                                        | Agnes mapping                                                          | Success output                         |
| ---------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------- |
| `POST /v1/chat/completions`        | JSON; `model`, non-empty `messages`                   | Whitelisted chat fields; optional `max_completion_tokens → max_tokens` | Agnes JSON/SSE body streamed unchanged |
| `POST /v1/images/generations`      | JSON; `model`, `prompt`, `size`; optional `n=1..10`   | Base64 flags; sequential single-image calls for `n > 1`                | Aggregated OpenAI ImagesResponse       |
| `POST /v1/images/edits`            | JSON; `model`, `prompt`, `size`, URL/Data URI `image` | Calls `/images/generations` with `extra_body.image`                    | OpenAI ImagesResponse subset           |
| `POST /v1/videos`                  | JSON or multipart; `model`, `prompt`                  | URL reference, seconds/frame and size/dimension conversion             | Agnes `video_id` becomes `id`          |
| `GET /v1/videos/:video_id`         | Authorized path request                               | `GET ../agnesapi?video_id=...`                                         | OpenAI Video subset                    |
| `GET /v1/videos/:video_id/content` | Authorized path request                               | Query status first                                                     | Completed: 302; pending/failed: 409    |

Global rules:

- `Authorization` is required, forwarded unchanged, never stored, and never
  logged.
- The only application variable is optional `AGNES_BASE_URL`; it defaults to
  `https://apihub.agnes-ai.com/v1` and must be HTTPS and end in `/v1`. Loopback
  HTTP is allowed for local development.
- Request and response models are never validated, mapped, defaulted, or
  replaced.
- Missing/invalid required values return 400. Unsupported optional parameters
  are silently omitted. Unsupported content types return 415.
- Ordinary JSON and video multipart bodies are limited to 1 MiB; JSON image
  edits are limited to 20 MiB. Oversized bodies return 413 before Agnes is
  called.
- Agnes non-2xx statuses are retained and normalized to an OpenAI error
  envelope. Network failures return 502. Creation requests are never retried.
- Client cancellation propagates to the Agnes request.
- The service has no persistent state, task map, database, cache, billing, user
  authentication, or rate limiter.

Image-count decisions:

- Missing or `null` `n` and `n=1` make one Agnes call. Other integers from 2
  through 10 make that many intentional calls sequentially; the gateway never
  forwards `n`, and these calls are not retries.
- Every call forwards the caller's arbitrary model unchanged and must return a
  valid `created` plus exactly one image. The aggregate keeps the first
  `created`, merges `data` in call order, and preserves safe headers from the
  last successful response.
- The first non-2xx, network failure, cancellation, or malformed success stops
  the sequence. The gateway returns no partial response and performs no retry;
  successful earlier creations cannot be rolled back.
- Fan-out increases upstream calls, potential cost, latency, and memory use,
  especially for Base64 output.
- Fan-out buffers at most 64 MiB of combined successful Agnes JSON bodies.
  Exceeding the limit returns 502, stops future calls, and yields no partial
  response; single-image success bodies remain streamed through.

Video mapping decisions:

- `seconds=4/8/12` maps to 24 FPS and `num_frames=97/193/289`.
- A valid `WIDTHxHEIGHT` maps to integer `width/height`; invalid values are
  ignored and Agnes chooses the output.
- `input_reference.image_url` maps only when it is an HTTP(S) URL without
  userinfo. Files, `file_id`, and Data URIs are ignored. The gateway does not
  resolve the hostname or assert public reachability.
- The content endpoint ignores unsupported `variant` values and always resolves
  the video asset.
- Completed content must contain a syntactically valid HTTP(S) URL without
  userinfo; otherwise the gateway returns 502. Redirects use 302, `no-store`,
  and `no-referrer` without resolving the target hostname.

## Milestones

### M0 — Specification baseline and project cleanup

- [x] Record the approved plan and 2026-07-10 documentation baseline.
- [x] Use the exact README tagline with the serial comma.
- [x] Remove Fresh demo UI/routes/middleware and use an API-only app.
- [x] Add an app factory with injectable fetch, base URL, and clock.
- [x] Pin dependencies, generate `deno.lock`, and add reproducible tasks.
- [x] Resolve the initial missing manual `node_modules` dependency setup.

Exit gate: fresh install, format, lint, type check, tests, and Fresh build pass.

### M1 — Authorization, upstream transport, and errors

- [x] Add shared Authorization enforcement for every supported route.
- [x] Add JSON/FormData parsing, required-field validation, and allowlists.
- [x] Enforce streamed request-body limits before parsing or calling Agnes.
- [x] Add `/v1` and sibling `/agnesapi` URL builders.
- [x] Normalize OpenAI, Agnes JSON, plain-text, empty, and network errors.
- [x] Return JSON 404/405/500 responses for API failures.
- [x] Avoid request/body/header logging and automatic retries.

Exit gate: common contract and security tests pass.

### M2 — Non-streaming chat completions

- [x] Implement `POST /v1/chat/completions` JSON handling.
- [x] Require an unchanged model and non-empty messages array.
- [x] Forward only supported chat fields.
- [x] Preserve tool calls, multimodal messages, usage, and response model.
- [x] Map `max_completion_tokens` only when `max_tokens` is absent.

Exit gate: normal, multimodal/tool fixture, filtering, and upstream-error tests
pass.

### M3 — Streaming chat completions

- [x] Bridge the Agnes ReadableStream without aggregation or event rewriting.
- [x] Preserve SSE content type, chunks, and `[DONE]`.
- [x] Normalize errors returned before streaming begins.
- [x] Propagate client cancellation to the upstream signal.

Exit gate: chunk fidelity, end marker, pre-stream error, and cancellation tests
pass.

### M4 — Image generation

- [x] Implement `POST /v1/images/generations`.
- [x] Implement deterministic URL/Base64 output mapping.
- [x] Preserve `created/data/url/b64_json/revised_prompt` responses.
- [x] Validate `n=1..10` and sequentially aggregate one Agnes creation per
      requested image without retries or partial results.
- [x] Ignore unmapped generation options.

Exit gate: URL, Base64, count fan-out, aggregation, validation, filtering, and
error tests pass.

### M5 — JSON image edits

- [x] Implement URL/Data URI JSON requests at `/v1/images/edits`.
- [x] Validate one or many HTTP(S)/image Data URI strings without
      fetching/decoding them.
- [x] Build Agnes `extra_body.image/response_format` correctly.
- [x] Return 415 for multipart image edits and document the limitation.

Exit gate: single URL, multiple URL, Data URI, both output formats, validation,
and error tests pass.

### M6 — Video creation

- [x] Accept JSON and OpenAI SDK multipart requests.
- [x] Map HTTP(S) URL references without userinfo and ignore unsupported
      references.
- [x] Convert seconds/size deterministically.
- [x] Use Agnes `/v1/videos` and expose `video_id` as `id`.
- [x] Avoid state/task maps and internal task-ID exposure.

Exit gate: text-to-video, URL image-to-video, both content types, parameter
mapping, malformed upstream, and error tests pass.

### M7 — Video status and content

- [x] Implement encoded `/agnesapi?video_id=...` status queries.
- [x] Transform Agnes lifecycle fields into the OpenAI Video subset.
- [x] Implement completed redirect and pending/failed/invalid-URL errors.
- [x] Preserve Agnes auth/error/rate-limit behavior.
- [x] Verify each lookup uses the current request's Authorization.

Exit gate: create ID can be polled and downloaded without gateway state.

### M8 — Delivery and release

- [x] Add CI for frozen install, check, tests, Fresh build, and Docker build.
- [x] Add an OpenAI JavaScript SDK contract test for chat/image/video.
- [x] Add a non-root, least-permission multi-stage Docker image.
- [x] Add a strict remote-preview smoke mode that sends the complete checklist
      through `GATEWAY_URL`.
- [x] Document Deno, Deno Deploy, Docker, all endpoints, limitations, and
      security behavior.
- [x] Run the then-current 2026-07-10 real Agnes API smoke checklist through the
      gateway with a caller-owned temporary key. This predates the count check.
- [ ] Repeat the smoke checklist against the final Deno Deploy preview revision.
- [ ] Publish and tag `v0.1.0`, retaining the previous deploy/image for
      rollback.

Exit gate: all local/CI gates plus the external smoke checklist pass before the
release tag is published.

## Test and acceptance matrix

Every supported endpoint must retain tests for:

1. Missing Authorization returns 401 and does not call Agnes.
2. Missing/invalid required fields return 400; missing video IDs return a JSON
   client error.
3. The public request becomes the exact Agnes URL, headers, and JSON body.
4. An Agnes success becomes the documented OpenAI-compatible response.
5. Agnes errors become an OpenAI envelope while retaining HTTP status.

Cross-cutting coverage includes arbitrary model pass-through, parameter
filtering, safe headers, URL/Base64 image formats, image-count validation and
sequential aggregation, 4/8/12-second frame mapping, stateless video IDs, SSE
chunk fidelity, cancellation, safe redirects, malformed upstream bodies,
request-size enforcement, URL/userinfo rejection, network failures,
preview-smoke helpers, and an actual OpenAI JavaScript SDK client.

CI tests use only an injected mock transport and never require an external
service or secret. A live smoke test is intentionally manual so a user key is
never stored in repository or CI configuration.

## Live Agnes verification — 2026-07-10

The in-process diagnostic smoke runner received the temporary key through stdin.
The key was not placed in a command argument, environment variable, file,
response log, or application log. This verified the gateway logic and real Agnes
behavior locally; the final deployed-preview run remains pending.

Verified successfully against the real Agnes API:

- Missing Authorization returns the local OpenAI-style 401 without an Agnes
  call.
- Non-streaming chat preserves the Agnes response model.
- Streaming chat returns SSE events and `[DONE]` through the gateway.
- Image generation returns a URL response.
- Base64 image generation returns a non-empty `b64_json` after applying the
  two-flag runtime compatibility fix.
- JSON URL image editing returns a URL response.
- URL image-to-video creation returns a public `video_id`; polling reaches
  `completed` at 100% without gateway state.
- Completed video content returns a valid HTTP(S) 302 redirect.
- Real Agnes 400, 429, overloaded-memory, and queue-full responses remain safe
  OpenAI-style errors with their upstream status.

Transient Agnes capacity/rate-limit failures were observed during the run and
succeeded after manual, non-automatic retry. This confirms why the gateway must
not automatically retry creation requests.

## Live Agnes image-count verification — 2026-07-12

One authorized, side-effectful native Agnes probe requested `n=2` with URL
output. Agnes returned a 2xx response, but the response did not contain exactly
two non-empty URL results. The probe was not retried automatically, and no
credential, response body, or asset URL was recorded in the repository.

This result did not establish usable native `n` support. Production therefore
uses a fixed sequential fan-out for `n > 1` instead of forwarding `n`, probing
per request, or falling back after an ambiguous response. Each fan-out call is
an intentional creation and may be billable.

After the fan-out implementation and mocked contracts passed, one separately
authorized count-only smoke request completed with HTTP 200 and exactly two URL
results from two sequential Agnes calls. This verified the aggregate behavior
without logging either generated asset URL. The second check validated the new
fan-out path; it was not a retry of the native capability probe.

The complete smoke suite was updated to require `n=2` after that focused check,
but the updated complete suite has not been rerun. Its mandatory run against the
final deployed preview remains pending.

## Decision log

- 2026-07-10: Approved an OpenAI-compatible subset rather than a complete API.
- 2026-07-10: Approved both JSON and OpenAI multipart wire formats for video
  creation.
- 2026-07-10: Approved HTTP(S) URL references for image-to-video; local files
  and `file_id` remain out of scope. Reachability is an upstream concern.
- 2026-07-10: Approved deterministic 24 FPS mapping for OpenAI video duration.
- 2026-07-10: Chose Agnes `video_id` as the public ID to preserve stateless
  polling.
- 2026-07-10: Chose a manual real-Agnes release gate so credentials never enter
  the application or CI.
- 2026-07-10: Live Agnes testing showed Base64 generation requires both
  `return_base64=true` and `extra_body.response_format=b64_json`; the gateway
  sends both despite the model document showing only the former.
- 2026-07-11: Added fixed 1 MiB ordinary and 20 MiB image-edit body limits to
  prevent unbounded buffering while retaining practical Data URI edits.
- 2026-07-11: Required HTTPS Agnes base URLs except explicit loopback
  development hosts and rejected URL userinfo.
- 2026-07-11: Distinguished the in-process diagnostic smoke from the strict
  `GATEWAY_URL` preview release gate; preview warnings now fail the run.
- 2026-07-12: A native Agnes `n=2` request returned 2xx without two URL results,
  so the gateway implements image counts with static sequential single-image
  fan-out, fail-fast aggregation, no partial results, and no retries.
- 2026-07-12: Limited buffered multi-image success bodies to 64 MiB, leaving
  runtime headroom under Deno Deploy's documented 512 MB application maximum.

## Source documents

- Agnes text: <https://agnes-ai.com/zh-Hans/docs/agnes-20-flash.md>
- Agnes image: <https://agnes-ai.com/zh-Hans/docs/agnes-image-21-flash.md>
- Agnes video: <https://agnes-ai.com/zh-Hans/docs/agnes-video-v20.md>
- Agnes common errors: <https://wiki.agnes-ai.com/en/docs/code.md>
- OpenAI API reference: <https://developers.openai.com/api/reference/>
- Deno Deploy limits: <https://docs.deno.com/deploy/pricing_and_limits/>
