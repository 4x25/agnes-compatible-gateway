# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases use
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Agnes 3.0 Flash compatibility: `tool_calls`/`tool_call_id` message fields
  complete the OpenAI function-calling round trip, including assistant messages
  whose `content` is `null`.
- Agnes Video 2.5 and 2.5 Flash compatibility: `seconds`/`size`/`aspect_ratio`/
  `mode` translation with `first_frame`/`last_frame`/`images`/`audios`/`videos`
  media fields, `extra_body` hoisting, local Flash limit validation, and
  `metadata.url` resolution for completed tasks.
- Video 2.5 public IDs embed the creation model (`<model>:<video_id>`) so the
  documented stateless query can send the exact `model_name` it requires.
- Dated live evidence for the three new models, including the Chat tool round
  trip, in
  [docs/contract-results/2026-09-18-agnes-3-flash-family.md](docs/contract-results/2026-09-18-agnes-3-flash-family.md).

### Changed

- Landing-page defaults, README examples, compatibility matrices, and OpenAPI
  document now reference `agnes-3.0-flash`, `agnes-image-2.5-flash`, and
  `agnes-video-2.5-flash`.
- Gated live and deployment probes default to the newest models and exercise the
  2.5 video dialect with model-qualified polling.

### Fixed

- Completed Agnes Video 2.5 tasks now resolve their media URL from
  `metadata.url`, in addition to the V2.0 top-level `url`.

## [0.1.0] - 2026-07-19

### Added

- Initial feasibility research and explicit OpenAI-to-Agnes compatibility policy
  for Chat, Images, and Videos.
- Caller-owned bearer-key forwarding with no production server key or model
  mapping.
- Chat completions, image generations/edits, and asynchronous video
  create/retrieve/content routes.
- OpenAI-shaped errors, ignored-parameter reporting, CORS, health checks, upload
  safeguards, SSE forwarding, image fan-out, and video byte-range proxying.
- Bilingual landing page, API playground, README, compatibility, deployment,
  testing, contribution, conduct, and security documentation.
- Dependency-free Chromium/CDP E2E coverage for all five playground workflows
  and six public routes through a loopback fake Agnes, including cancellation,
  multipart uploads, video polling/content, previews, and credential hygiene.
- OpenAPI 3.1 contract, locked Deno build, non-root Docker image, CI matrix, and
  multi-architecture GHCR release workflow with SBOM and provenance.
- A separately gated acceptance probe for real Deno Deploy health/CORS, Chat
  SSE, multipart image editing, video polling, and byte-range content.

### Changed

- The landing page now uses its current request origin in runnable examples and
  the same-origin playground, removes duplicate setup/security sections and
  compatibility filters, and keeps the full brand name visible on narrow
  headers.
- Chat input messages are rebuilt from documented `role`/`content` fields;
  unknown nested fields are reported and removed, while undocumented `tool`
  role/tool-result messages are rejected. Top-level `tools` and `tool_choice`
  remain partially compatible pass-through controls.
- Standard image `response_format` takes precedence over Agnes
  `return_base64`/`extra_body.response_format`, with overridden paths reported.
- Standard image `response_format: b64_json` now uses the live-verified Agnes
  `extra_body.response_format` control after contract probes showed the
  documented `return_base64` control could still return a URL.
- Video creation now exposes Agnes `video_id` as the public `id` and polls the
  documented `/agnesapi?video_id=...` endpoint after live testing showed that
  the legacy task-ID route rejected a newly-created task. A bounded read-only
  fallback preserves retrieval for IDs returned by earlier gateway versions.
- The OpenAPI contract names each supported Agnes extension and mirrors the
  runtime CORS request-header allowlist.
- Upstream response-header waits are bounded, and client cancellation is
  normalized without cutting off healthy SSE or media streams after headers.
- Image fan-out failure paths safely cancel every unread response body without
  masking the primary upstream, parsing, shape, or aggregate-size error.
- Multi-architecture releases build Fresh once on the native BuildKit worker and
  copy the self-contained bundle into each target runtime. This avoids
  unreliable Deno/Vite module resolution under QEMU while also removing source,
  tests, build tools, and dependency caches from the production image.
- The release workflow now inspects the published manifest for both supported
  architectures and health-checks the immutable registry digest before it can
  report success.

### Security

- Logs and errors exclude credentials, request bodies, untrusted upstream echo,
  and caller-controlled correlation values; credentialed upstream redirects are
  refused.
- Generated media is fetched without Authorization and returned with private,
  no-store cache policy and credential-aware response variation.

[Unreleased]: https://github.com/4x25/agnes-compatible-gateway/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/4x25/agnes-compatible-gateway/releases/tag/v0.1.0
