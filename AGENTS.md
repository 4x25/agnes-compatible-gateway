# AGENTS.md

## Scope and Language

These instructions apply to the entire repository. A more deeply nested
`AGENTS.md`, if added later, may refine them for its subtree.

Write repository artifacts in English by default. This includes source-code
comments, documentation, examples, error messages, test names, changelog
entries, commit messages, and pull-request text. Exceptions are limited to
verbatim upstream material, language-specific test fixtures, or an explicit
request for localized content. Conversation with a user may follow the user's
language; persisted project content should remain English.

## Project Overview

`agnes-compatible-gateway` is an unofficial, stateless OpenAI-compatible API
gateway for Agnes text, image, and video APIs. It is intentionally an
OpenAI-compatible subset, not a complete OpenAI implementation.

Preserve these invariants in every change:

- Never map, alias, default, or validate model names against a local list. Send
  the request model to Agnes unchanged and return the model reported by Agnes.
- Require a non-empty `Authorization` header and forward it unchanged for that
  request only. Do not configure or read a server-side Agnes API key.
- Never persist credentials, task state, request bodies, generated assets, or
  user data.
- Silently omit unsupported or unmappable optional request parameters. Validate
  required fields and supported content types normally.
- Do not automatically retry upstream calls, especially image or video creation
  requests, because retries can duplicate side effects.
- Keep the service storage-free: no database, cache, queue, billing, user auth,
  or rate limiter belongs in the MVP.
- Return OpenAI-style error envelopes while preserving Agnes HTTP statuses and
  safe request/rate-limit headers.
- Enforce fixed request-body limits before parsing: 1 MiB for ordinary
  JSON/video multipart and 20 MiB for JSON image edits.
- Limit the combined Agnes JSON success bodies buffered for image-count fan-out
  to 64 MiB. Return 502 and stop before another call when the limit is exceeded.
- Require HTTPS for Agnes upstreams except explicit loopback HTTP development
  hosts. Never accept URL userinfo in upstream or media URLs.

The supported public surface is:

- `POST /v1/chat/completions` (JSON, including streaming SSE)
- `POST /v1/images/generations` (JSON, URL or Base64 output)
- `POST /v1/images/edits` (JSON URL/Data URI inputs; multipart is unsupported)
- `POST /v1/videos` (JSON and OpenAI SDK multipart)
- `GET /v1/videos/:video_id`
- `GET /v1/videos/:video_id/content` (302 for completed content)

Do not add unrelated OpenAI endpoints without an explicit scope decision.

## Repository Layout

- `main.ts`: production Fresh 2 entrypoint; reads only `AGNES_BASE_URL` as
  application configuration.
- `gateway/app.ts`: app factory, route registration, authorization, and request
  orchestration.
- `gateway/transforms.ts`: pure validation and OpenAI-to-Agnes/Agnes-to-OpenAI
  transformations.
- `gateway/upstream.ts`: Agnes URL construction, network calls, cancellation,
  and response pass-through.
- `gateway/errors.ts`: OpenAI error envelopes and safe upstream error/header
  normalization.
- `tests/`: mocked contract tests and an OpenAI JavaScript SDK compatibility
  test.
- `scripts/live_smoke.ts`: opt-in real-Agnes diagnostic and deployed-preview
  smoke runner that reads a temporary key from stdin.
- `docs/IMPLEMENTATION_PLAN.md`: milestone status, decisions, and live API
  findings.
- `docs/DEPLOYMENT.md`: Deno Deploy, Docker, reverse-proxy, and smoke guidance.
- `CONTRIBUTING.md` and `SECURITY.md`: human contribution and private
  vulnerability-reporting guidance.
- `Dockerfile` and `.github/workflows/ci.yml`: release/runtime and CI gates.

Generated directories (`_fresh/`, `coverage/`, `node_modules/`) must not be
committed.

## Architecture and Compatibility Rules

Use `createGatewayApp` with injected dependencies for testability. Keep route
handlers thin and place deterministic field mapping in pure transformer
functions. Rebuild upstream bodies from explicit allowlists; never spread an
untrusted client object into an Agnes request.

Important compatibility details:

- Chat success bodies and SSE streams are passed through without buffering or
  model rewriting. `max_completion_tokens` maps to `max_tokens` only when
  `max_tokens` is absent.
- URL image generation uses `extra_body.response_format=url`. Current Agnes
  runtime behavior requires Base64 generation to send both `return_base64=true`
  and `extra_body.response_format=b64_json`.
- Image generation accepts `n` as omitted, `null`, or an integer from 1 through
  10. Omitted, `null`, and 1 make one Agnes call. For larger values, make that
  many intentional calls sequentially without forwarding `n`; these calls are
  not retries. Preserve the arbitrary request model on every call, require one
  image per success, and merge `data` in order with the first valid `created`.
  Stop on the first error, cancellation, or malformed success and return no
  partial data. Never retry the failed call. Single-image successes remain
  streamed through; multi-image aggregation has a fixed 64 MiB response limit.
- Image edits call Agnes `/images/generations`, validate HTTP(S) URLs without
  userinfo or `image/*` Data URIs, normalize `image` to an array, and place it
  under `extra_body.image`. Do not fetch or decode input images in the gateway.
- Video durations `4`, `8`, and `12` map to 24 FPS and `97`, `193`, and `289`
  frames. A valid `WIDTHxHEIGHT` maps to integer `width` and `height`.
- Only syntactically valid HTTP(S) video reference-image URLs without userinfo
  are mapped. Uploaded files, `file_id`, and video Data URIs are ignored. Do not
  claim the gateway verifies reachability or public DNS resolution.
- Expose Agnes `video_id` as the public `id` so polling remains stateless. Video
  status uses the sibling `/agnesapi?video_id=...` endpoint.
- Do not invent missing video metadata. Content lookup returns 409 while a task
  is pending or failed, 502 for malformed completed output, and a
  scheme-restricted 302 for a syntactically valid HTTP(S) URL without userinfo.

When live Agnes behavior differs from published documentation, add a focused
contract test, document the verified behavior in the implementation plan, and
prefer the smallest compatibility adjustment.

## Development Commands

- `deno install --frozen`: install exactly the dependencies in `deno.lock`.
- `deno task dev`: start the Fresh/Vite development server.
- `deno task check`: run formatting checks, linting, and TypeScript checking.
- `deno task test`: run mocked endpoint contracts and the OpenAI SDK test.
- `deno task test:coverage`: collect profiles under `coverage/` and print a
  local coverage report.
- `deno task build`: build the production Fresh bundle under `_fresh/`.
- `deno task deploy:build`: frozen-install dependencies and build for Deno
  Deploy.
- `deno task start`: serve an existing production bundle on port 8000.
- `deno task smoke`: run the side-effectful in-process/Agnes diagnostic suite.
- `deno task smoke:preview`: run the strict suite through `GATEWAY_URL`; any
  compatibility warning fails the preview release gate.

Pin direct dependencies in `deno.json`. When dependencies change, regenerate
`deno.lock`, run a frozen install, and include the lockfile change. Keep the
direct Vite version aligned with the version resolved by the Fresh plugin to
avoid duplicate private plugin types.

## Coding Standards

- Use TypeScript, two-space indentation, and Deno's formatter. Do not fight
  `deno fmt` with manual alignment.
- Use `camelCase` for functions/variables, `PascalCase` for interfaces/types,
  and `UPPER_SNAKE_CASE` for constants.
- Prefer Web Platform APIs available in Deno Deploy (`Request`, `Response`,
  `Headers`, `URL`, `ReadableStream`, and `fetch`).
- Prefer small, typed functions and discriminated results over exceptions for
  expected validation failures.
- Add comments only when they explain a non-obvious constraint or decision;
  write every new comment in English.
- Do not add application-level request logging. Never log request headers,
  bodies, Data URIs, prompts, or upstream asset URLs.
- Preserve client cancellation by passing the incoming `AbortSignal` to Agnes.
- Preserve safe headers deliberately; do not proxy hop-by-hop, cookie, content
  length, or arbitrary upstream headers.

## Testing Requirements

Tests use `Deno.test` and `@std/assert`. Normal tests must use an injected fake
`fetch`; they must not require network access, credentials, timing-dependent
external state, or a running server.

For every endpoint, cover at least:

1. Missing Authorization returns 401 and never calls Agnes.
2. Missing or invalid required input returns a local 400 (or the documented
   route-specific client error).
3. The OpenAI-style request becomes the exact Agnes URL, headers, and body.
4. Agnes success becomes the documented OpenAI-compatible response.
5. Agnes JSON/plain-text/network errors become an OpenAI envelope with the
   correct status.

Add focused coverage for SSE chunk fidelity and `[DONE]`, client cancellation,
parameter filtering, model pass-through, body-size enforcement, multipart
parsing, Base64 flags, fan-out response-size enforcement, URL/userinfo
rejection, stateless video polling, scheme-restricted redirects, malformed
upstream responses, and representative 401/404/413/429/5xx errors. Update the
SDK contract test when a public wire shape changes.

Before handing off a change, run:

```sh
deno task check
deno task test
deno task build
git diff --check
```

Run Docker builds when a Docker engine is available or rely on the CI container
job. Report any verification that could not be run.

## Security and Live Testing

The only optional application setting is
`AGNES_BASE_URL=https://apihub.agnes-ai.com/v1`. Fresh may read standard build
identifier variables internally; these are not application credentials. The
value must use HTTPS except for explicit loopback development hosts.

Never introduce `AGNES_API_KEY`, `OPENAI_API_KEY`, a hard-coded key, or a key
fallback. Do not place real keys in source, docs, fixtures, command arguments,
environment files, CI secrets, shell history, or tool output.

Real API smoke tests are side-effectful and must not run automatically. Run them
only when the user explicitly authorizes live calls and supplies a disposable
key. Feed the key to either smoke task through stdin with terminal echo
disabled. `deno task smoke` is diagnostic and does not validate a deployment;
`deno task smoke:preview` must target the final preview and pass without
warnings before release. Do not automatically retry failed image/video creation;
wait for a capacity or rate-limit window and retry manually only when
authorized. After the run, verify no key remains in the worktree or output and
explicitly remind the user to revoke it. Generated Agnes assets/tasks may also
need manual cleanup.

## Documentation, Commits, and Pull Requests

Update README and `docs/` whenever public behavior, supported parameters,
deployment, security, or verified upstream quirks change. Keep examples safe,
copy-pasteable, and free of real credentials. Record material live API findings
in the implementation plan's decision log.

`README.md` is the canonical English overview. Keep `README.zh-CN.md`
synchronized whenever user-facing behavior, examples, compatibility tables, or
structure changes. Human contributors start with `CONTRIBUTING.md`. Security
reports follow `SECURITY.md` and must not be disclosed in public issues.

Use short imperative Conventional Commit-style subjects such as `feat:`, `fix:`,
`test:`, `docs:`, or `chore:`. Keep commits focused. Pull requests should
describe behavior and compatibility changes, security implications, tests run,
documentation updates, and any unverified release gate. Screenshots are normally
unnecessary for this API-only project.

## Definition of Done

A change is complete when it preserves the project invariants, includes the
necessary contract tests, keeps all persisted content in English by default,
updates relevant documentation, passes local quality/build gates, and clearly
reports external checks that remain pending. Do not tag or publish a release
unless explicitly requested and the documented preview smoke gate has passed.
