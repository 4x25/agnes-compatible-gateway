# Security Policy

## Supported versions

This project is currently pre-release. No stable version has been published, and
there is not yet a multi-version security support policy. Security fixes are
developed against the default branch on a best-effort basis.

This section will be updated when the first supported release is published.
Older commits, forks, and independently modified deployments are not covered by
a support commitment.

## Reporting a vulnerability

Please do not report vulnerabilities in a public issue, discussion, pull
request, or chat.

Use GitHub's **Privately report a security vulnerability** option in the
repository's Security tab when it is available:

<https://github.com/4x25/agnes-compatible-gateway/security/advisories/new>

If private vulnerability reporting is unavailable, open a minimal public issue
asking a maintainer to establish a private contact channel. Do not include the
vulnerability type, affected code, reproduction steps, logs, or evidence in that
issue.

A useful private report includes:

- the affected revision and deployment model;
- a concise description of the impact and trust boundary involved;
- minimal reproduction steps using redacted or synthetic data;
- any known mitigations or proposed fixes; and
- whether the issue has been disclosed anywhere else.

Never include a live API key, Authorization header, user prompt, request body,
Data URI, generated asset URL, upstream asset URL, or video task ID. Redact
these values even in private reports. If a credential may have been exposed,
revoke it before reporting the issue.

Only test against deployments and Agnes accounts you are authorized to use. Do
not access other users' data, degrade a shared service, or create unnecessary
billable image or video jobs while validating a report.

## What to expect

Maintainers will make a best-effort attempt to acknowledge and triage a private
report. Response and resolution times depend on maintainer availability,
severity, reproducibility, and upstream behavior; this volunteer project does
not promise a response-time or remediation SLA.

When practical, maintainers will coordinate remediation and public disclosure
with the reporter. Please allow time for investigation and a fix before
publishing details. A report may need to be shared privately with an affected
upstream provider when resolving it requires upstream action.

## Security boundaries

The gateway forwards each caller's Authorization header to its configured
Agnes-compatible upstream. It deliberately has no server-side Agnes key,
credential store, task database, automatic retry layer, or application-level
request logging. Deployment operators are responsible for TLS, access to their
runtime configuration, and ensuring that proxies and hosting platforms do not
log secrets or sensitive request data.

The application limits ordinary JSON and video multipart bodies to 1 MiB and
JSON image edits to 20 MiB. Agnes upstreams must use HTTPS except for explicit
loopback development hosts. Platform-level limits may be lower and remain the
operator's responsibility.

See [`AGENTS.md`](AGENTS.md) for repository security invariants and
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) for deployment guidance.
