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
- The OpenAPI contract names each supported Agnes extension and mirrors the
  runtime CORS request-header allowlist.
- Upstream response-header waits are bounded, and client cancellation is
  normalized without cutting off healthy SSE or media streams after headers.
- Image fan-out failure paths safely cancel every unread response body without
  masking the primary upstream, parsing, shape, or aggregate-size error.

### Security

- Logs and errors exclude credentials, request bodies, untrusted upstream echo,
  and caller-controlled correlation values; credentialed upstream redirects are
  refused.
- Generated media is fetched without Authorization and returned with private,
  no-store cache policy and credential-aware response variation.

No version has been published from this changelog yet. Validate the
corresponding Git tag and GHCR digest before treating an image as a release.
