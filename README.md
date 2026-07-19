# Agnes OpenAI Compatible Gateway

[![CI](https://github.com/4x25/agnes-compatible-gateway/actions/workflows/ci.yml/badge.svg)](https://github.com/4x25/agnes-compatible-gateway/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Container](https://img.shields.io/badge/GHCR-container-2496ED)](https://github.com/4x25/agnes-compatible-gateway/pkgs/container/agnes-compatible-gateway)

English · [简体中文](README.zh-CN.md)

[Maintainer reference deployment](https://agnes-compatible-gateway.zo.deno.net)
— caller keys traverse that operator-managed origin; self-host for sensitive
workloads.

An unofficial, lightweight, open-source gateway that presents Agnes AI text,
image, and video APIs through a focused OpenAI-compatible interface. It is
designed for Deno Deploy and also ships as a Docker image.

> [!IMPORTANT]
> This project is not affiliated with OpenAI or Agnes AI. Compatibility means
> the documented HTTP subset, not identical model behavior or feature parity.

## Why this gateway?

- **Bring your own key (BYOK):** each request carries the caller's Agnes API
  key. The gateway has no production API key and does not persist credentials.
- **Small and stateless:** no model aliases, database, cache, queue, billing,
  gateway rate limiting, or automatic retries.
- **Portable:** built with Fresh 2 and Web Standards APIs for Deno Deploy and
  Docker.
- **Explicit compatibility:** translated, passed-through, ignored, partial, and
  Agnes-specific fields are documented instead of hidden.

## Supported API

| Method and path                     | Compatibility                                                |
| ----------------------------------- | ------------------------------------------------------------ |
| `POST /v1/chat/completions`         | OpenAI Chat Completions subset; JSON and upstream SSE        |
| `POST /v1/images/generations`       | Text-to-image; `n` is implemented by atomic parallel fan-out |
| `POST /v1/images/edits`             | JSON image references and OpenAI-style multipart uploads     |
| `POST /v1/videos`                   | OpenAI Videos create subset; JSON and multipart              |
| `GET /v1/videos/{video_id}`         | Retrieve/poll an asynchronous Agnes video task               |
| `GET /v1/videos/{video_id}/content` | Stream completed video bytes; supports `Range`               |
| `GET /healthz`                      | Unauthenticated local health check; never calls Agnes        |

`model` is always required and sent unchanged. This gateway deliberately does
not expose the obsolete `/v1/video/generations` spelling. See the
[compatibility matrix](docs/compatibility.md) and the
[OpenAPI 3.1 document](static/openapi.yaml) for details.

Chat message input is intentionally narrower than the whole OpenAI schema:
messages contain only `role` and `content`, support `system`, `user`, and
`assistant` (`developer` is converted to `system`), and reject `tool`
role/tool-result messages. Top-level `tools` and `tool_choice` remain partially
compatible pass-through controls. For images, the standard `response_format`
always overrides the Agnes `return_base64` extension; overridden and unsupported
paths are reported in `X-Agnes-Gateway-Ignored-Params`.

## Quick start

Requirements: Deno 2.5 or newer.

```bash
git clone https://github.com/4x25/agnes-compatible-gateway.git
cd agnes-compatible-gateway
deno install --frozen
deno task dev
```

The site and API are available at `http://localhost:5173` in development.
Production builds listen on port `8000` by default:

```bash
deno task build
deno task start
```

Configure only the upstream base URL when needed:

```bash
export AGNES_BASE_URL="https://apihub.agnes-ai.com/v1"
```

Call the gateway with your own Agnes key:

```bash
curl http://localhost:8000/v1/chat/completions \
  -H 'Authorization: Bearer YOUR_AGNES_API_KEY' \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "agnes-2.0-flash",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": false
  }'
```

OpenAI clients can point their `baseURL` at this gateway and use the Agnes key
as the client API key. Only the endpoints and fields in this repository's
compatibility matrix are guaranteed.

```ts
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: Deno.env.get("AGNES_API_KEY"),
  baseURL: "http://localhost:8000/v1",
});

const response = await client.chat.completions.create({
  model: "agnes-2.0-flash",
  messages: [{ role: "user", content: "Hello!" }],
});
```

## Docker

Run the published image without putting a key in the container:

```bash
docker run --rm -p 8000:8000 \
  ghcr.io/4x25/agnes-compatible-gateway:latest
```

Or build locally:

```bash
docker compose up --build
```

The container runs as a non-root user and exposes `/healthz`. Details, including
Deno Deploy setup and immutable image tags, are in
[Deployment](docs/deployment.md).

## Configuration and security

| Variable                      | Default                          | Runtime use                                              |
| ----------------------------- | -------------------------------- | -------------------------------------------------------- |
| `AGNES_BASE_URL`              | `https://apihub.agnes-ai.com/v1` | Agnes upstream base URL                                  |
| `AGNES_API_KEY_ONLY_FOR_TEST` | unset                            | Live contract tests only; production code never reads it |

All `/v1/*` generation and retrieval requests require
`Authorization: Bearer <Agnes key>`. The gateway forwards that header only to
the configured Agnes upstream. Never put a key in a public browser page or a
server environment variable intended for production gateway traffic. The
home-page tester keeps its key in memory only.

The API permits `Accept`, `Authorization`, `Content-Type`, `Range`, and
`X-Request-ID` headers with `Access-Control-Allow-Origin: *`, but never enables
cookie credentials. Errors use the OpenAI-shaped
`{ "error": { "message", "type", "param", "code" } }` envelope. Unsupported
fields that can be safely ignored are reported by
`X-Agnes-Gateway-Ignored-Params`. That header exposes only bounded, sanitized
field paths; unsafe names are redacted and excess entries are truncated.

See [Security Policy](SECURITY.md) for reporting vulnerabilities and
[Compatibility](docs/compatibility.md) for data and size limits.

## Project milestones

Status is updated when the corresponding acceptance evidence exists; a source
change by itself does not mark a milestone complete.

| Milestone                               | Status                   | Evidence / completion criterion                                                                                                          |
| --------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| M0 — Feasibility and protocol decisions | ✅ Complete (2026-07-16) | [Research baseline and compatibility decisions](docs/compatibility.md)                                                                   |
| M1 — Runtime and core foundation        | ✅ Complete (2026-07-17) | [CI acceptance](https://github.com/4x25/agnes-compatible-gateway/actions/runs/29562152663) passed Deno 2.5.6/2.9.3, Docker, and Chromium |
| M2 — Chat and Images                    | ✅ Complete (2026-07-18) | [Live contract acceptance](docs/contract-results/2026-07-18-m2.md) covers Chat, errors, Image URL/Base64, and Data-URI editing           |
| M3 — Video lifecycle                    | ✅ Complete (2026-07-18) | [Live contract acceptance](docs/contract-results/2026-07-18-m3.md) covers real creation, video-ID polling, and Range content download    |
| M4 — Home page and API playground       | ✅ Complete (2026-07-16) | [Full Chromium/CDP acceptance](docs/browser-testing.md) covers both languages, five playground workflows, all six routes, and safety     |
| M5 — Community-ready release            | 🚧 In progress           | [Deno Deploy/GHCR acceptance](docs/contract-results/2026-07-19-m5.md) passed; only final `v0.1.0` publication remains                    |

### Local acceptance snapshot — 2026-07-16

- Clean copies with empty external caches passed `deno install --frozen`,
  formatting, lint, type-checking, all 41 tests, and production builds on both
  Deno 2.5.6 and 2.9.3. The suite comprises 36 gateway tests, one official
  OpenAI TypeScript SDK workflow test, one OpenAPI contract test, and three
  Fresh route tests.
- Chromium 146 exercised Chat SSE cancellation/success, image generation,
  multipart image editing, text-to-video, and image-to-video through a loopback
  fake Agnes. It observed every public route, video polling/content/preview, six
  responsive widths, both languages, keyboard/reduced-motion behavior, key
  non-persistence, request redaction, and media downloads without Authorization.
- `deno task test:live` fails closed unless both explicit safety gates are set;
  no real Agnes request was made during this acceptance run.

### CI acceptance snapshot — 2026-07-17

- [Run 29562152663](https://github.com/4x25/agnes-compatible-gateway/actions/runs/29562152663)
  passed frozen install, formatting, lint, type-checking, all tests, and the
  production build on Deno 2.5.6 and 2.9.3.
- The same run built the production Docker image and verified `/healthz` from a
  read-only, non-root container with dropped capabilities.
- Its Chromium job repeated the bilingual, responsive, playground, and
  credential-safety acceptance on GitHub-hosted infrastructure.

### Release-candidate acceptance — 2026-07-18

- `v0.1.0-rc.2` published an anonymously pullable OCI index to GHCR with both
  `linux/amd64` and `linux/arm64` images.
- Each architecture carries an SPDX SBOM and SLSA provenance attestation, the
  immutable source SHA as `DENO_DEPLOYMENT_ID`, MIT/source/version OCI labels,
  and the unprivileged `deno` runtime user.
- [Release run 29655101517](https://github.com/4x25/agnes-compatible-gateway/actions/runs/29655101517)
  inspected the remote manifest and started the published digest with a
  read-only filesystem, dropped capabilities, and a successful `/healthz`.

### Deno Deploy acceptance — 2026-07-19

- The maintainer-hosted Production deployment passed `/healthz`, CORS, Chat SSE,
  a real multipart image edit, video creation/terminal polling, and a `206`
  byte-range content request using the gated deployment probe.
- Chromium 146 independently passed both languages, all six responsive widths,
  keyboard/focus, reduced-motion, and credential non-persistence against the
  deployed origin.
- The [redacted acceptance record](docs/contract-results/2026-07-19-m5.md)
  contains only public deployment metadata, statuses, field types, and redacted
  request IDs.

Only the final `v0.1.0` GitHub/GHCR publication remains before M5 can be marked
complete. The Deno Deploy and multi-architecture candidate requirements have
passed.

## Documentation

- [Compatibility matrix and known gaps](docs/compatibility.md)
- [Deployment: Deno Deploy and Docker](docs/deployment.md)
- [Live contract testing](docs/contract-testing.md)
- [Browser smoke testing](docs/browser-testing.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Changelog](CHANGELOG.md)

## Contributing

Issues and pull requests are welcome. Please read
[CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md)
first. By participating, you agree not to include real API keys, generated
private media, or upstream response URLs in public reports.

## License

[MIT](LICENSE) © 2026 4×25.
