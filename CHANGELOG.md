# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases use
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
- A separately gated deployment acceptance probe for real Preview health/CORS,
  Chat SSE, multipart image editing, video polling, and byte-range content.

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

No version has been published from this changelog yet. Validate the
corresponding Git tag and GHCR digest before treating an image as a release.
