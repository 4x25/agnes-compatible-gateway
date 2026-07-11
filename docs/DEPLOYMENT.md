# Deployment guide

The gateway is stateless and can run on Deno Deploy or in any container
platform. Each instance needs outbound HTTPS access to Agnes; it does not need a
database, persistent volume, queue, or server-side Agnes key.

## Configuration

The only optional application variable is:

```text
AGNES_BASE_URL=https://apihub.agnes-ai.com/v1
```

The value must be an absolute HTTP(S) URL ending in `/v1`. A trailing slash is
accepted. The gateway derives the Agnes video lookup endpoint by replacing the
final `/v1` with `/agnesapi`.

Do not add `AGNES_API_KEY`, `OPENAI_API_KEY`, or another fixed key to the
deployment. User keys arrive in each request's `Authorization` header.

## Deno Deploy

1. Import the repository into Deno Deploy.
2. Use `deno task build` as the build command.
3. Use `_fresh/server.js` as the application entrypoint.
4. Optionally set `AGNES_BASE_URL`; no secret is required by the gateway.
5. Deploy to a preview environment and run the smoke checklist below before
   promoting the revision.

Fresh reads deployment build identifiers such as `DENO_DEPLOYMENT_ID`
internally. They are platform metadata, not gateway configuration or
credentials.

## Docker

Build and run locally:

```sh
docker build -t agnes-compatible-gateway:local .
docker run --rm -p 8000:8000 agnes-compatible-gateway:local
```

With a custom Agnes-compatible upstream:

```sh
docker run --rm -p 8000:8000 \
  -e AGNES_BASE_URL=https://example.com/v1 \
  agnes-compatible-gateway:local
```

The runtime image uses the unprivileged `deno` user. Its Deno permissions allow
only network access, reading the built application, and reading the explicit
Agnes/Fresh deployment variables.

For releases, publish an immutable version tag such as `v0.1.0` and retain the
previous image tag for rollback. Do not use only `latest` in production.

## Reverse proxy considerations

- Preserve the incoming `Authorization` header to the gateway.
- Do not add request-header or request-body logging at the proxy layer.
- Disable proxy buffering for `/v1/chat/completions` so SSE chunks are delivered
  promptly.
- Allow image-generation requests to run for up to several minutes.
- Permit 302 responses and external `Location` headers from video content
  requests.
- Apply body-size limits appropriate for JSON Data URI image edits.

## Manual smoke checklist

Use a caller-owned Agnes key only in your local shell. Do not save it in the
repository, Deno Deploy settings, container environment, or CI.

```sh
export GATEWAY_URL=https://your-preview.example
export AGNES_API_KEY=your-temporary-user-key
```

Verify all of the following:

- A request without `Authorization` returns an OpenAI-style 401.
- Non-streaming chat returns an Agnes completion and unchanged response model.
- Streaming chat emits multiple SSE chunks and `[DONE]` without buffering.
- Image generation succeeds once with URL output and once with Base64 output.
- A JSON image edit succeeds using a public URL or a small Data URI.
- Video creation returns a `video_*` ID that can be polled without gateway
  state.
- A completed video content request returns 302 and the redirect downloads the
  MP4.
- An intentionally invalid model/key returns the original Agnes status inside an
  OpenAI-style error envelope.

After verification, remove the shell variable:

```sh
unset AGNES_API_KEY
```

For a repeatable local run without placing the key in a process argument or
environment variable, pass it through stdin:

```sh
read -rsp "Temporary Agnes API key: " AGNES_API_KEY; echo
printf '%s\n' "$AGNES_API_KEY" | deno task smoke
unset AGNES_API_KEY
```

The smoke runner prints only endpoint status/progress, never the key or response
payloads. It creates real image and video jobs and may take several minutes.

## Rollback

- Deno Deploy: promote the previously known-good deployment revision.
- Container platforms: redeploy the previous immutable image tag.
- No database or task migration is required because the gateway stores no state.
