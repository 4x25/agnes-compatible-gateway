# Contributing

Thank you for helping improve Agnes Compatible Gateway. Contributions are
welcome when they preserve its focused role as an unofficial, stateless
OpenAI-compatible subset for Agnes text, image, and video APIs.

## Before you start

Read [`AGENTS.md`](AGENTS.md) before changing the project. It is the canonical
reference for architecture, compatibility invariants, coding standards, testing,
credential handling, and the definition of done. The
[`MVP implementation plan`](docs/IMPLEMENTATION_PLAN.md) records accepted
protocol decisions and verified Agnes behavior.

In particular, changes must preserve these boundaries:

- models and caller Authorization headers pass through without local mapping or
  server-side credentials;
- the gateway does not store credentials, user data, assets, or task state;
- unsupported optional parameters are omitted, while required fields remain
  validated;
- side-effectful upstream requests are not retried automatically; and
- new OpenAI endpoints or stateful services require an explicit scope decision.

Open an issue before starting a substantial API, compatibility, security, or
architecture change. Focused fixes, tests, and documentation improvements can
usually go directly to a pull request.

Security vulnerabilities must follow [`SECURITY.md`](SECURITY.md). Do not
disclose them in a public issue or pull request.

## Development setup

Install [Deno](https://docs.deno.com/runtime/getting_started/installation/) (the
project is tested with `2.9.2`), clone the repository, and install the locked
dependencies:

```sh
git clone https://github.com/4x25/agnes-compatible-gateway.git
cd agnes-compatible-gateway
deno install --frozen
```

Start the development server with:

```sh
deno task dev
```

Normal development and test commands do not need an Agnes API key. Tests use an
injected mock upstream and must remain independent of network access and
external state.

## Making a change

1. Create a focused branch from the current default branch.
2. Keep route orchestration thin and put deterministic mappings in pure
   transformer functions.
3. Rebuild upstream payloads from explicit allowlists; never spread untrusted
   client objects into them.
4. Add or update contract tests for public request and response behavior.
5. Update documentation when compatibility, configuration, deployment, or
   security behavior changes.
6. Use short, imperative Conventional Commit subjects such as `feat:`, `fix:`,
   `test:`, `docs:`, or `chore:`.

Repository artifacts are written in English by default. `README.md` is the
canonical English overview. When a change affects its user-facing behavior,
examples, compatibility tables, or structure, update `README.zh-CN.md` in the
same pull request so the maintained Simplified Chinese version stays in sync.
Localized prose should preserve meaning; it does not need to be a literal
translation.

## Testing

Run a single test file or matching test while developing:

```sh
deno task test tests/config_test.ts
deno task test --filter "chat" tests/gateway_test.ts
```

Before opening a pull request, run the complete local gates:

```sh
deno task check
deno task test
deno task build
git diff --check
```

Run a Docker build when a change affects the container or runtime packaging and
a Docker engine is available. If a relevant check cannot be run, explain why in
the pull request.

Do not run either smoke task as routine validation. Both call the real Agnes
API, can create billable assets and tasks, and require explicit maintainer
coordination plus a disposable caller-owned credential supplied through stdin.
`deno task smoke` is a local diagnostic; `deno task smoke:preview` is the strict
deployed-preview release gate. Never add a real credential to source, fixtures,
command arguments, environment files, CI, issues, or pull requests.

## Pull requests

Keep each pull request small enough to review as one behavior change. The
description should cover:

- the problem and chosen behavior;
- compatibility and security implications;
- tests and builds run;
- documentation changed; and
- external validation or release gates that remain pending.

Review may request narrower scope, additional contract tests, or evidence that
unsupported fields and sensitive values do not cross the gateway boundary.
Passing CI is required but does not replace review of protocol and security
behavior.

Maintainers decide when to merge, deploy, tag, or publish a release. A merged
contribution does not imply that a release or hosted service will be published.
