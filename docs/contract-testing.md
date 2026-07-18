# Live Agnes contract testing

[简体中文](contract-testing.zh-CN.md)

The normal test suite uses an injected fake Agnes server. It is deterministic,
does not need a network or API key, and is safe for pull requests. Live tests
exist only to verify upstream behavior that Agnes documentation does not fully
specify.

## Safety gates

Live tests must refuse to start unless **both** conditions are true:

1. `RUN_AGNES_LIVE_TESTS=1`
2. `AGNES_API_KEY_ONLY_FOR_TEST` contains a non-empty disposable Agnes test key

Run the dedicated task after both values are set. It does not load `.env`:

```bash
read -rsp "Disposable Agnes test key: " AGNES_API_KEY_ONLY_FOR_TEST
printf '\n'
export AGNES_API_KEY_ONLY_FOR_TEST
RUN_AGNES_LIVE_TESTS=1 deno task test:live
unset AGNES_API_KEY_ONLY_FOR_TEST
```

Reading the key silently keeps it out of shell history and terminal output.

The script is intentionally named `tests/live_contract.ts`, so normal
`deno task test` discovery and CI never evaluate it or read its key variable. It
accepts only HTTPS upstream URLs, disables redirects, and reports bounded
field/type summaries rather than response values. `.env.example` documents only
empty/disabled placeholders; never add a non-empty key or enabled switch to it,
a GitHub Actions workflow, Docker, Deno Deploy, a test snapshot, or an issue.
The key must not be printed, even when a test fails.

This task calls Agnes directly; it does not send requests through the gateway.
In particular, `chat-tools` records an upstream contract that Agnes has not
fully documented. A successful probe does not make `tool` role/tool-result
messages part of the gateway's public subset: the gateway currently accepts only
`system`, `user`, and `assistant` messages after translating `developer` to
`system`.

## Selecting probes

`AGNES_LIVE_SCOPES` is a comma-separated allowlist. It defaults to `chat`, the
smallest probe. Available values are:

| Scope          | Upstream work                                                                   |
| -------------- | ------------------------------------------------------------------------------- |
| `chat`         | One short non-streaming completion                                              |
| `chat-sse`     | One short streaming completion; validates UTF-8 events and `[DONE]`             |
| `chat-tools`   | Two short completions covering a forced tool call and its `tool` result message |
| `errors`       | One fixed empty-JSON 400 request and a 401 request with a fixed fake token      |
| `image`        | One 1K URL-output text-to-image generation                                      |
| `image-base64` | One 1K Base64-output text-to-image generation                                   |
| `image-edit`   | One 1K Data-URI image-to-image generation with Base64 output                    |
| `video`        | One minimal 9-frame Data-URI image-to-video task plus task-ID retrieval         |
| `all`          | Every probe above; must be used by itself                                       |

For example, explicitly run the two currently ambiguous image contracts:

```bash
read -rsp "Disposable Agnes test key: " AGNES_API_KEY_ONLY_FOR_TEST
printf '\n'
export AGNES_API_KEY_ONLY_FOR_TEST
RUN_AGNES_LIVE_TESTS=1 \
  AGNES_LIVE_SCOPES=image-base64,image-edit \
  deno task test:live
unset AGNES_API_KEY_ONLY_FOR_TEST
```

Set `AGNES_LIVE_VIDEO_WAIT_FOR_COMPLETION=1` with the `video` scope to poll the
same created task until a terminal state, validate the final URL, and request
byte zero with `Range: bytes=0-0` without forwarding the Agnes key. Without it,
the probe performs one retrieval and validates only the asynchronous task
envelope. Model names can be overridden with `AGNES_LIVE_CHAT_MODEL`,
`AGNES_LIVE_IMAGE_MODEL`, and `AGNES_LIVE_VIDEO_MODEL`; they default to the
models in the Agnes documents linked from this repository. `AGNES_BASE_URL`
defaults to `https://apihub.agnes-ai.com/v1`.

Use a disposable, least-privilege account and rotate/revoke the key after a
probe. Live tests can create billable text, image, or video work; review current
Agnes pricing and quota before running them. Generation calls are never retried.
The video probe retries only a transient `404` while reading the newly created
task.

## Coverage and manual checklist

Record the date, Agnes request ID, status, and a redacted structural summary—
never prompts, Base64 data, full media URLs, or credentials.

The automated scopes cover Chat JSON, basic SSE framing, a forced tool call and
tool-result round trip, safe 400/401 envelope shapes, text-to-image URL/Base64,
Data-URI image editing, and Data-URI video creation/retrieval. Opting into video
completion also covers the final media URL and byte-range behavior. The `errors`
scope never prints error-body values; its 401 request uses a fixed fake token,
not the disposable valid key.

The following observations remain manual or require a deliberately targeted
future probe; this script does **not** claim to cover them:

- tool-call deltas inside an SSE stream;
- public-URL image-to-image input and historical exact-size normalization;
- video status transitions and returned `seconds`/`size` across model tiers;
- account-driven 429 responses and unplanned Agnes 5xx responses.

Do not intentionally induce 429 or 5xx failures, and do not paste an error body
into a log or issue. If either occurs naturally, retain only the status, safe
header names, redacted request ID, and field/type shape.

Do not make live tests part of ordinary CI or fork pull-request workflows. A
maintainer may run them manually in a protected environment and link only a
redacted result from the corresponding milestone.

## Recorded evidence

- [2026-07-18 M2 partial acceptance](contract-results/2026-07-18-m2.md): Chat,
  SSE, tools, safe error envelopes, and Image URL output passed. Text-to-image
  Base64 remains unresolved after a `200` without a valid `b64_json`, followed
  by `503` and `504` responses. Data-URI image editing passed, so only
  text-to-image Base64 keeps M2 open.
