# Deployment guide

The gateway is stateless and can run on Deno Deploy or in a container platform.
Each instance needs outbound HTTPS access to Agnes; it does not need a database,
persistent volume, queue, or server-side Agnes key.

## Configuration

The only optional application variable is:

```text
AGNES_BASE_URL=https://apihub.agnes-ai.com/v1
```

The value must be an HTTPS URL ending in `/v1`, with no userinfo, query, or
fragment. A trailing slash is accepted. Plain HTTP is allowed only for
`localhost`, `127.0.0.0/8`, and `[::1]` development upstreams. The gateway
derives the Agnes video lookup endpoint by replacing the final `/v1` with
`/agnesapi`.

Do not add `AGNES_API_KEY`, `OPENAI_API_KEY`, or another fixed key to the
deployment. User keys arrive in each request's `Authorization` header. A custom
upstream receives those credentials and must be operated or trusted by the
deployment owner.

## Request-size limits

The application rejects oversized bodies before calling Agnes:

| Route class                                     | Maximum body |
| ----------------------------------------------- | -----------: |
| Chat, image generation, and JSON video creation |        1 MiB |
| Multipart video creation                        |        1 MiB |
| JSON image edits, including Data URIs           |       20 MiB |

Both declared `Content-Length` values and streamed bytes are enforced. An
overage returns an OpenAI-style `413 request_too_large` response. Hosting and
reverse-proxy limits may be lower but should not be higher unless the
application limits change at the same time.

## Deno Deploy

1. Import the repository into Deno Deploy.
2. Use `deno task deploy:build` as the build command. It runs
   `deno install --frozen` before the Fresh build because npm dependencies use
   manual `node_modules` mode.
3. Use `_fresh/server.js` as the application entrypoint.
4. Optionally set `AGNES_BASE_URL`; no secret is required by the gateway.
5. Deploy to a preview environment.
6. Run the strict preview smoke procedure below before promoting the revision.

Fresh reads deployment build identifiers such as `DENO_DEPLOYMENT_ID`
internally. They are platform metadata, not gateway configuration or
credentials.

## Docker

No prebuilt image is currently published. Build and run from source:

```sh
docker build -t agnes-compatible-gateway:local .
docker run --rm -p 8000:8000 agnes-compatible-gateway:local
```

With a trusted custom Agnes-compatible upstream:

```sh
docker run --rm -p 8000:8000 \
  -e AGNES_BASE_URL=https://example.com/v1 \
  agnes-compatible-gateway:local
```

The runtime image uses the unprivileged `deno` user. Deno may access the
network, read only `/app/_fresh`, and read only the listed Agnes/Fresh
environment variables. Network access cannot be host-scoped in the image because
`AGNES_BASE_URL` is selected at runtime.

Where the container platform supports them, also use a read-only root
filesystem, drop Linux capabilities, prevent privilege escalation, and avoid
mounting secrets into the container. Validate platform-specific hardening
against a preview before production rollout.

For releases, publish an immutable version tag such as `v0.1.0` and retain the
previous image tag for rollback. Do not use only `latest` in production.

## Reverse proxy considerations

- Preserve the incoming `Authorization` header to the gateway.
- Do not add request-header or request-body logging at the proxy layer.
- Disable proxy buffering for `/v1/chat/completions` so SSE chunks are delivered
  promptly.
- Allow several minutes for each Agnes image-generation call. Because `n > 1`
  runs calls sequentially, size client, platform, and proxy timeouts for the
  requested count (up to roughly ten times the single-image allowance). A
  timeout can occur after earlier images were already created and billed.
- Multi-image generation buffers at most 64 MiB of aggregate Agnes success JSON.
  Keep additional runtime headroom below the platform memory limit, especially
  for Base64 output. Deno Deploy currently documents a 512 MB application
  maximum.
- Permit 302 responses and external `Location` headers from video content
  requests. Do not forward caller authorization to the redirect target.
- Apply route-specific request limits no higher than 1 MiB for ordinary
  JSON/video multipart routes and 20 MiB for JSON image edits.
- Use HTTPS between every non-loopback hop.

## Manual smoke checklist

Smoke tests call the real Agnes API, create billable image/video jobs, and may
take several minutes. They never run in CI. Use a disposable caller-owned key
and revoke it after testing.

The runner reads the key from stdin only. Do not place it in a command argument,
environment variable, file, deployment setting, or shell history.

### Local diagnostic smoke

`deno task smoke` exercises an in-process gateway against the configured Agnes
upstream. It is useful for protocol diagnostics but does **not** validate a
deployed preview. Some transient Base64/image-edit failures are reported as
`PASS_WITH_WARNINGS` so individual checks can be retried deliberately.

```bash
read -rsp "Temporary Agnes API key: " AGNES_API_KEY
echo
printf '%s\n' "$AGNES_API_KEY" | deno task smoke
unset AGNES_API_KEY
```

### Strict preview smoke

`deno task smoke:preview` sends the complete checklist through the deployed
`GATEWAY_URL`. The URL must use HTTPS, except for an explicit loopback HTTP
address, and may include a gateway base path before `/v1`.

```bash
GATEWAY_URL=https://your-preview.example
read -rsp "Temporary Agnes API key: " AGNES_API_KEY
echo
printf '%s\n' "$AGNES_API_KEY" |
  GATEWAY_URL="$GATEWAY_URL" deno task smoke:preview
unset AGNES_API_KEY GATEWAY_URL
```

Preview mode is strict: every required compatibility check must pass, the
process must exit zero, and the final line must be `SMOKE_RESULT=PASS`. Warnings
fail the preview gate.

The checklist covers:

- local rejection of missing `Authorization`;
- non-streaming and streaming chat, including `[DONE]`;
- URL and Base64 image generation;
- JSON URL image editing;
- URL image-to-video creation, polling, and content redirect;
- OpenAI error normalization for an intentionally invalid credential; and
- response-model pass-through and stateless use of the returned video ID.

The runner reports endpoint status, progress, and sanitized HTTP/error-code
summaries. It does not print keys, prompts, raw response excerpts, generated
payloads, asset URLs, or video IDs. It uses manual redirect handling so caller
authorization is never forwarded to an asset host.

For deliberate recovery after a transient upstream failure, the local and
preview tasks retain selective flags such as `--base64-only`, `--edit-only`,
`--media-only`, `--video-only`, and `--generated-video-only`. A
`--content-id=...` recovery is also available; treat task IDs as sensitive and
do not paste them into issues or logs. Selective checks do not replace a final
complete strict preview pass.

Use `--image-count-only` to verify `n: 2` image-generation compatibility with
one URL-output request. The check requires exactly two syntactically valid
HTTP(S) URLs without userinfo and prints only a PASS/status summary, never
response bodies or asset URLs:

```bash
read -rsp "Temporary Agnes API key: " AGNES_API_KEY
echo
printf '%s\n' "$AGNES_API_KEY" | deno task smoke --image-count-only
unset AGNES_API_KEY
```

To perform the same focused check through a deployment, use the complete
pipeline so both `GATEWAY_URL` and the stdin key reach the task:

```bash
GATEWAY_URL=https://your-preview.example
read -rsp "Temporary Agnes API key: " AGNES_API_KEY
echo
printf '%s\n' "$AGNES_API_KEY" |
  GATEWAY_URL="$GATEWAY_URL" deno task smoke:preview --image-count-only
unset AGNES_API_KEY GATEWAY_URL
```

This call creates two billable images; do not retry it automatically after an
ambiguous timeout or upstream failure.

The complete `deno task smoke:preview` gate also requests `n: 2` during its URL
image-generation step and fails unless exactly two URL results are returned. The
focused flag is for diagnosis and does not replace that final complete run.

After testing, revoke the disposable key and clean up generated Agnes assets or
tasks when the upstream supports cleanup.

## Rollback

- Deno Deploy: promote the previously known-good deployment revision.
- Container platforms: redeploy the previous immutable image tag.
- No database or task migration is required because the gateway stores no state.
