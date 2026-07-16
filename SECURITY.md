# Security policy

[简体中文](SECURITY.zh-CN.md)

## Supported versions

| Version               | Security fixes                              |
| --------------------- | ------------------------------------------- |
| Latest tagged release | Supported                                   |
| `master`              | Best effort; may contain unreleased changes |
| Older tagged releases | Upgrade to the latest release               |

Before the first tagged release, only `master` receives fixes.

## Report a vulnerability privately

Use GitHub's
[private vulnerability reporting](https://github.com/4x25/agnes-compatible-gateway/security/advisories/new).
Do not open a public issue. If private reporting is unavailable, contact the
repository owner through their GitHub profile without including exploit details
and ask for a private channel.

Include only what is needed to reproduce safely:

- affected version, Git SHA, deployment type, and endpoint;
- impact and prerequisites;
- minimal reproduction with fake credentials and non-private media;
- `X-Request-ID` if useful, after confirming it contains no secret;
- suggested mitigation, if known.

Never send a real Agnes key, Authorization header, private prompt, Base64 media,
full generated-media URL, account data, or unrelated personal information.
Revoke any key that may have been exposed before reporting.

Maintainers target an acknowledgement within 7 days and a status update within
14 days. Resolution time depends on severity and whether the flaw is in this
gateway, Agnes, Deno, or another dependency. Please allow coordinated disclosure
before publishing details.

## Security model

- **BYOK:** production runtime code accepts a caller's bearer key per request;
  it does not read `AGNES_API_KEY_ONLY_FOR_TEST` and does not store keys.
- **Trusted upstream:** operators control `AGNES_BASE_URL`. Setting it to an
  untrusted host gives that host caller credentials by design.
- **Header isolation:** Authorization is sent only to the configured Agnes API
  origin, not to a final media-storage URL.
- **No user storage:** prompts and uploaded media exist only for request
  processing. Multipart files are converted in memory; there is no database,
  cache, or durable queue.
- **Browser tester:** the API key remains in component memory and must not be
  placed in LocalStorage, URL parameters, rendered HTML, copied examples, or
  telemetry.
- **Logs and errors:** do not contain credentials, bodies, Base64 media, full
  upstream media URLs, or internal stacks.
- **Resource bounds:** upload, file-count, and aggregate-response limits reduce
  accidental memory exhaustion; they are not a substitute for platform-level
  abuse protection on a public deployment.

## In-scope examples

- credential leakage to logs, errors, HTML, storage, or the wrong origin;
- authentication bypass on a `/v1/*` operation;
- SSRF or unsafe redirect behavior that exposes caller credentials;
- CORS behavior that enables unintended browser credentials;
- request parsing or streaming flaws that lead to material denial of service;
- dependency or container configuration that makes the documented deployment
  materially unsafe.

Agnes account compromise, model output quality/safety, Agnes platform outages,
and limits imposed by a hosting provider are generally upstream concerns, but
the maintainers will help route a responsibly reported issue.
