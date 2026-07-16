# syntax=docker/dockerfile:1.7

# Keep the baseline explicit so local and release builds are reproducible.
# CI additionally tests the current stable Deno 2.x release.
ARG DENO_VERSION=2.5.6

FROM denoland/deno:${DENO_VERSION} AS build
WORKDIR /app

# Cache dependency resolution independently from application source changes.
COPY deno.json deno.lock ./
RUN deno install --frozen

COPY . .

# Fresh uses this identity to keep build/deployment snapshots distinct. The
# release workflow overrides it with the immutable Git commit SHA.
ARG DENO_DEPLOYMENT_ID=local-container
ENV DENO_DEPLOYMENT_ID=${DENO_DEPLOYMENT_ID}
RUN deno task build

FROM denoland/deno:${DENO_VERSION} AS runtime
ARG DENO_DEPLOYMENT_ID=local-container

ENV DENO_DEPLOYMENT_ID=${DENO_DEPLOYMENT_ID}
WORKDIR /app

# Keep the runtime offline-capable: Fresh's generated server may reference
# source modules, npm packages, and modules cached in DENO_DIR.
COPY --from=build --chown=deno:deno /app /app
COPY --from=build --chown=deno:deno /deno-dir /deno-dir

USER deno
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD deno eval "const response = await fetch('http://127.0.0.1:8000/healthz'); if (!response.ok) Deno.exit(1)"

ENTRYPOINT ["deno"]
CMD ["task", "start"]
