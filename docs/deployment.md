# Deployment

[简体中文](deployment.zh-CN.md)

The gateway is stateless. A deployment needs outbound HTTPS access to Agnes, but
it does **not** need a database, cache, queue, persistent volume, or server API
key.

## Deno Deploy (current platform)

These instructions target the current Deno Deploy platform at
[console.deno.com](https://console.deno.com), not Deploy Classic. Deno's
documentation says Deploy Classic will shut down on **2026-07-20**.

1. Fork this repository and create a new app in a Deno Deploy organization.
2. Link the fork through the Deno Deploy GitHub integration.
3. Select the **Fresh** framework preset. Fresh requires no additional platform
   adapter.
4. Verify the detected install command is `deno install --frozen` and the build
   command is `deno task build`. The preset should configure the dynamic Fresh
   runtime; do not deploy this API as a static site.
5. Leave `AGNES_BASE_URL` unset to use `https://apihub.agnes-ai.com/v1`, or set
   it as a plain environment variable for Production and Development contexts
   when using an operator-controlled Agnes-compatible upstream.
6. Do **not** configure `AGNES_API_KEY_ONLY_FOR_TEST` in Deno Deploy.
7. Create the app, inspect the warm-up log, then request `/healthz` on its
   preview URL before promoting the deployment.

Deno Deploy sets deployment identity for builds. Every Docker image also sets a
non-empty `DENO_DEPLOYMENT_ID` so Fresh does not reuse an old snapshot across
releases.

### Deno Deploy caveats

- Multipart inputs are read into instance memory. The gateway rejects a file
  above 20 MiB, a body above 50 MiB, or more than 16 image files.
- Image requests can remain open for 60–360 seconds and video content can be
  large. Actual wall-time, memory, egress, and instance-lifecycle behavior
  depends on the chosen Deno Deploy plan. Validate those flows on a preview; use
  Docker when the platform limit is insufficient.
- `/healthz` confirms the process is available, not that Agnes accepts a key or
  that a model is currently healthy. Health checks intentionally do not spend
  caller quota.
- Browser traffic is allowed through CORS. Hosting a public gateway means any
  visitor can send their own Agnes key through your origin; publish a privacy
  notice appropriate to your deployment.

The milestone cannot be marked complete until a real preview has passed the
health, Chat SSE, image upload, and video polling checks. Repository CI alone
does not establish that result.

### Automated Preview acceptance

The opt-in deployment probe exercises those checks through the public gateway,
not directly against Agnes. It defaults to the non-billable `health` scope and
refuses redirects or non-HTTPS deployment URLs, except explicit loopback HTTP
for local diagnostics. Run the complete acceptance only with a disposable
caller-owned Agnes key after reviewing current upstream pricing:

```bash
read -rsp "Disposable Agnes test key: " AGNES_API_KEY_ONLY_FOR_TEST
printf '\n'
export AGNES_API_KEY_ONLY_FOR_TEST
RUN_DEPLOYMENT_LIVE_TESTS=1 \
  DEPLOYMENT_SMOKE_BASE_URL=https://your-preview.example \
  DEPLOYMENT_SMOKE_SCOPES=all \
  deno task test:deployment
unset AGNES_API_KEY_ONLY_FOR_TEST
```

The scopes are `health`, `chat-sse`, `image-upload`, and `video`; `all` must be
used by itself. The script runs them sequentially, never retries a generation,
and emits only status codes, redacted request IDs, and bounded field/type
shapes. It validates CORS and cache controls, Chat SSE termination, a real
multipart edit, video terminal polling, and `Range: bytes=0-0` through the
gateway content route. It never prints the key, prompts, IDs, URLs, Base64, or
media bytes and is not part of ordinary CI.

## Published Docker image

Version tags are published to:

```text
ghcr.io/4x25/agnes-compatible-gateway
```

Use an immutable release tag in production:

```bash
docker run --detach \
  --name agnes-gateway \
  --restart unless-stopped \
  --read-only \
  --tmpfs /tmp:size=64m \
  --publish 8000:8000 \
  ghcr.io/4x25/agnes-compatible-gateway:0.1.0
```

The image supports `linux/amd64` and `linux/arm64`, runs as the unprivileged
`deno` user, and includes OCI provenance and an SBOM when created by the release
workflow. Verify that the requested tag exists before deployment; the project
does not claim a release before its Git tag workflow succeeds.

### Build locally

```bash
docker compose up --build
curl --fail http://localhost:8000/healthz
```

Or build directly with a unique deployment identity:

```bash
docker build \
  --build-arg DENO_DEPLOYMENT_ID="local-$(git rev-parse --short HEAD)" \
  --tag agnes-compatible-gateway:local .
docker run --rm -p 8000:8000 agnes-compatible-gateway:local
```

No caller API key belongs in the image, Compose file, or container environment.
Callers supply it in the HTTP Authorization header.

## Configuration

| Variable                      | Required            | Default                          | Notes                                                                                                                           |
| ----------------------------- | ------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `AGNES_BASE_URL`              | No                  | `https://apihub.agnes-ai.com/v1` | Trailing slashes are normalized. Set only to an upstream controlled/trusted by the operator because caller keys are sent there. |
| `AGNES_API_KEY_ONLY_FOR_TEST` | Never in production | unset                            | Recognized only by explicitly enabled live contract tests.                                                                      |
| `RUN_AGNES_LIVE_TESTS`        | Never in production | unset                            | Must equal `1` as a second upstream live-test safety gate.                                                                      |
| `RUN_DEPLOYMENT_LIVE_TESTS`   | Never in production | unset                            | Must equal `1` before the external deployment probe can run.                                                                    |
| `DEPLOYMENT_SMOKE_BASE_URL`   | Test process only   | unset                            | Explicit HTTPS origin of an already running gateway.                                                                            |
| `DEPLOYMENT_SMOKE_SCOPES`     | Test process only   | `health`                         | Comma-separated deployment probes, or `all` by itself.                                                                          |

## Reverse proxy and operations

- Terminate TLS before exposing a Docker deployment to the internet. The app
  itself listens on HTTP inside the container.
- Preserve streaming: disable response buffering for Chat SSE and video content
  routes and choose proxy timeouts that cover long image generations.
- Forward `Range` and preserve `206`, `Content-Range`, `Accept-Ranges`, and
  `Content-Length` on the video content route.
- Do not log Authorization headers, multipart bodies, prompts, Base64 media, or
  final media URLs. Application logs are intentionally limited to a one-way hash
  of the request ID, route, status, and duration.
- Alert on sustained 5xx/429 rates and latency, but do not treat an individual
  Agnes 429 as a gateway health failure.
- Roll back by selecting the previous immutable GHCR version. No schema or data
  migration is needed because the service has no storage.

## Release images

Pushing a signed/versioned Git tag matching `v*.*.*` starts the release
workflow. It publishes semantic-version, major/minor, SHA, and `latest` (stable
versions only) tags for both architectures. The workflow uses GitHub's OIDC
attestation path and GitHub Container Registry; it does not require a registry
password secret.

Before tagging, require green CI, update `CHANGELOG.md`, verify both README
milestone tables, run the opt-in contract suite with a disposable test key, and
complete the Deno Deploy preview checklist.
