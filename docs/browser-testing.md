# Browser smoke testing

[简体中文](browser-testing.zh-CN.md)

The landing-page smoke test uses Chromium's built-in DevTools Protocol, so the
project does not need Playwright, Puppeteer, or a downloaded browser package. It
verifies:

- switching between English and Simplified Chinese;
- absence of page-level horizontal overflow at 360, 600, 1024, and 1280 px;
- keyboard Tab order, visible focus, labels, and button/tab semantics for the
  locale, API-key, and playground controls;
- computed styles under `prefers-reduced-motion: reduce`, including disabled
  smooth scrolling and effectively suppressed transitions/repeated animation;
- real playground submission for Chat SSE, image generation, multipart image
  editing, text-to-video, and image-to-video, including video polling/content;
- cancel-state behavior, sanitized raw requests, image/video previews, and
  download/open controls across all six public API routes;
- a synthetic API-key marker never enters `localStorage`, `sessionStorage`,
  cookies, rendered text/attributes/serialized DOM, or another form field; and
- the **Clear sensitive data** action removes the marker from the password
  field.

The markers are generated locally and are not real Agnes keys. For its workflow
tests, the script starts a loopback-only fake Agnes server and injects that
origin only into the script-managed gateway process. Browser calls still cross
the real gateway handlers and protocol transformations, but no request reaches
Agnes or another external upstream. A temporary one-pixel PNG exercises both
multipart workflows and is removed during cleanup.

## Run locally

Deno 2.5 or newer and a Chromium-compatible binary are required. The script
auto-detects the browser from common Linux/macOS/Windows installation paths and
commands on `PATH`:

```bash
deno task test:browser
```

Without additional configuration, the script builds the current source, chooses
a free loopback port, starts the Fresh production server, waits for `/healthz`,
runs the assertions, and stops the server and browser even after a failure.
Override the browser path when needed:

```bash
CHROMIUM_PATH=/usr/bin/chromium deno task test:browser
```

To test an already running local server, Preview deployment, or production
deployment, set its origin. In this mode the script does not start or stop the
server. It also skips request-submitting playground E2E because an external
gateway cannot be safely redirected to the local fake Agnes; the language,
viewport, keyboard, motion, and credential-persistence checks still run:

```bash
BROWSER_SMOKE_BASE_URL=http://127.0.0.1:8000 \
  CHROMIUM_PATH=/usr/bin/chromium \
  deno task test:browser
```

Optional controls:

| Variable                   | Default              | Purpose                                              |
| -------------------------- | -------------------- | ---------------------------------------------------- |
| `CHROMIUM_PATH`            | auto-detected        | Override with a Chromium path or command name        |
| `BROWSER_SMOKE_BASE_URL`   | unset                | Reuse this origin instead of starting a local server |
| `BROWSER_SMOKE_PORT`       | a free loopback port | Port for the script-managed Fresh production server  |
| `BROWSER_SMOKE_SKIP_BUILD` | unset                | Set to `1` only to reuse an existing `_fresh` build  |
| `BROWSER_SMOKE_TIMEOUT_MS` | `600000`             | Per-phase build, startup, navigation, and UI timeout |

The process needs permission to run child processes, open loopback sockets, read
the Chromium binary, create a temporary browser profile/PNG, and read the
variables above. The repository task uses `-A` so it works consistently across
Deno versions.

## Troubleshooting

- If Chromium is not auto-detected, set `CHROMIUM_PATH`; do not add a
  machine-specific symlink or browser binary to the repository. An explicit
  override always takes priority over built-in candidates and `PATH`.
- In a container or root session the script already supplies Chromium's
  `--no-sandbox` and `--disable-dev-shm-usage` flags.
- Increase `BROWSER_SMOKE_TIMEOUT_MS` on a cold or resource-constrained build
  machine.
- `BROWSER_SMOKE_SKIP_BUILD=1` is useful for a quick repeat after a successful
  build; omit it for release evidence so stale assets cannot pass the test.
- `BROWSER_SMOKE_BASE_URL` must be an `http://` or `https://` origin exposing
  both `/` and `/healthz`.
