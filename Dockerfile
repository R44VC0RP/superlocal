FROM oven/bun:1.4.0 AS build
WORKDIR /app

COPY package.json bun.lock ./
COPY apps/web/package.json apps/web/package.json
COPY apps/local-host/package.json apps/local-host/package.json
COPY apps/mock-api/package.json apps/mock-api/package.json
COPY packages/inbox-sdk/package.json packages/inbox-sdk/package.json
RUN bun --no-env-file install --frozen-lockfile

COPY . .
RUN bun --no-env-file run build:web

FROM oven/bun:1.4.0
WORKDIR /app
COPY --from=build --chown=bun:bun /app /app

# Docker initializes a fresh named volume with this directory's ownership.
# Never recursively chown, reset, or regenerate an existing installation.
RUN mkdir /persist && chown bun:bun /persist && chmod 700 /persist
ENV SUPERLOCAL_CONFIG=/persist/superlocal.local.json \
    SUPERLOCAL_DATA_DIR=/persist/data \
    SUPERLOCAL_WEB_BIND=0.0.0.0
USER bun
EXPOSE 5178
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD bun --no-env-file -e 'for (const url of ["http://127.0.0.1:8790/health", "http://127.0.0.1:5178/"]) { const r = await fetch(url); if (!r.ok) process.exit(1); await r.arrayBuffer(); }'
CMD ["bun", "--no-env-file", "scripts/dev.ts", "--built"]
