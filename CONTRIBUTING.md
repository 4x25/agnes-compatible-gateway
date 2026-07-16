# Contributing

[简体中文](CONTRIBUTING.zh-CN.md)

Thank you for helping improve Agnes OpenAI Compatible Gateway. Contributions
should keep the service small, stateless, transparent, and safe for callers who
bring their own Agnes API key.

Please follow the [Code of Conduct](CODE_OF_CONDUCT.md). Security reports belong
in the private channel described by [SECURITY.md](SECURITY.md), not an issue.

## Before opening a change

- Search existing issues and the [compatibility matrix](docs/compatibility.md).
- For a new protocol field, link both the current OpenAI and Agnes documentation
  and state whether it is pass-through, translated, ignored, partial, or an
  Agnes extension.
- Keep these boundaries: no server API key, model mapping, database, cache,
  durable queue, billing, gateway rate limiting, or automatic generation retry.
- Never include a real Authorization header, API key, private prompt, Base64
  media, full generated-media URL, or user data in an issue, fixture, snapshot,
  screenshot, commit, or CI log.

## Development setup

Use Deno 2.5 or newer:

```bash
git clone https://github.com/4x25/agnes-compatible-gateway.git
cd agnes-compatible-gateway
deno install --frozen
deno task dev
```

Useful checks:

```bash
deno task check
deno task test
deno task test:browser
deno task build
docker compose up --build
```

The ordinary test suite must be deterministic and use an injected fake Agnes
upstream. It must not require a network or credential. Read
[Live contract testing](docs/contract-testing.md) before any real upstream
probe; live probes require two explicit environment gates and a disposable test
key. The dependency-free [browser smoke test](docs/browser-testing.md) starts
its own local server by default and documents how to select another Chromium
binary or an already running deployment.

## Architecture expectations

- Protocol translation belongs in framework-independent TypeScript and accepts
  injected `fetch` where network behavior is involved. Fresh routes should stay
  thin.
- Preserve Web Stream backpressure and cancellation for SSE and media. Do not
  buffer a stream merely to inspect or reformat it.
- Validate required data and safety limits at the gateway boundary. Optional
  unsupported fields should be ignored only when a valid request remains, and
  must be reported in `X-Agnes-Gateway-Ignored-Params`.
- Normalize errors without leaking credentials, bodies, internal stacks, or
  storage URLs. Logs should contain only safe operational metadata.
- Add JSDoc to exported interfaces and comments for non-obvious conversions or
  security decisions. Avoid comments that only repeat the code.
- Keep English and Simplified Chinese documentation behaviorally equivalent.

## Tests for protocol changes

At minimum, add table-driven unit tests for conversions and handler tests for:

- valid and invalid JSON or multipart inputs;
- upstream success, 4xx/5xx, 429, malformed bodies, and transport failure;
- ignored-field reporting and OpenAI-shaped errors;
- boundary sizes/counts and atomic image fan-out;
- SSE chunk boundaries/cancellation or video `Range`, when applicable;
- proof that Authorization is sent only to the configured Agnes API origin and
  not a media-storage origin.

If a public field, path, status, header, or limit changes, update
`static/openapi.yaml` plus both compatibility documents in the same pull
request. Do not mark a README milestone complete without its stated acceptance
evidence.

## Pull requests

1. Keep the change focused and explain the compatibility decision.
2. Use clear commits; Conventional Commit prefixes such as `feat:`, `fix:`,
   `docs:`, and `test:` are welcome but not required.
3. Run all checks locally and include the commands/results in the pull request.
4. Include screenshots for visible UI changes at representative mobile and
   desktop widths, with secrets and generated private media removed.
5. Expect review to prioritize security, compatibility transparency, streaming
   behavior, and deployment portability.

By submitting a contribution, you agree that it is licensed under the
repository's [MIT License](LICENSE).
