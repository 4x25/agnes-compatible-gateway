FROM denoland/deno:2.9.2 AS build

WORKDIR /app

COPY deno.json deno.lock ./
RUN deno install --frozen

COPY gateway ./gateway
COPY main.ts vite.config.ts ./
RUN deno task build

FROM denoland/deno:2.9.2 AS runtime

ENV DENO_NO_UPDATE_CHECK=1
WORKDIR /app

COPY --from=build --chown=deno:deno /app/_fresh ./_fresh

USER deno
EXPOSE 8000

CMD ["deno", "serve", "--allow-env=AGNES_BASE_URL,DENO_DEPLOYMENT_ID,GITHUB_SHA,CI_COMMIT_SHA", "--allow-net", "--allow-read=/app/_fresh", "--port=8000", "_fresh/server.js"]
