# syntax=docker/dockerfile:1.7

# Keep the baseline explicit so local and release builds are reproducible.
# CI additionally tests the current stable Deno 2.x release.
ARG DENO_VERSION=2.9.3

# Fresh's production bundle is architecture-independent. Build it on the
# native BuildKit worker instead of running Deno/Vite through QEMU for every
# target architecture; the latter can corrupt module resolution under arm64
# emulation. The final stage still uses the requested target architecture.
FROM --platform=$BUILDPLATFORM denoland/deno:${DENO_VERSION} AS build
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

FROM --platform=$TARGETPLATFORM denoland/deno:${DENO_VERSION} AS runtime
ARG DENO_DEPLOYMENT_ID=local-container

ENV DENO_DEPLOYMENT_ID=${DENO_DEPLOYMENT_ID}
WORKDIR /app

# Fresh emits a self-contained server bundle. Copy only that bundle and the
# public files it serves, keeping build tools, source, tests, and dependency
# caches out of the runtime image.
COPY --from=build --chown=deno:deno /app/_fresh /app/_fresh
COPY --from=build --chown=deno:deno /app/static /app/static

USER deno
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD deno eval "const response = await fetch('http://127.0.0.1:8000/healthz'); if (!response.ok) Deno.exit(1)"

ENTRYPOINT ["deno"]
CMD ["serve", "--allow-env", "--allow-net", "--allow-read", "_fresh/server.js"]
