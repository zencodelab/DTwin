FROM node:22-alpine

WORKDIR /app

# Workspace manifests first so a dependency install is cached independently of
# source edits.
COPY package.json package-lock.json ./
COPY packages/types/package.json ./packages/types/
COPY packages/db/package.json    ./packages/db/
COPY apps/ingest/package.json    ./apps/ingest/

RUN npm ci --omit=dev --workspace @dtwin/ingest --include-workspace-root

COPY packages/types ./packages/types
COPY packages/db    ./packages/db
COPY apps/ingest    ./apps/ingest

# curl for the healthcheck; the alpine base has neither curl nor wget.
RUN apk add --no-cache curl

# uid 1000 already exists in the base image. Nothing here writes to disk.
USER node

EXPOSE 8787

# /readyz is the drain check, not a liveness ping — degraded when the registry
# is empty, the buffer is at its cap, or the last write failed.
#
# Docker has ONE health probe where an orchestrator has two, so this has to
# choose. Readiness is right for Compose, which reports `unhealthy` and does not
# restart on it. It is WRONG anywhere unhealthy means restart (Swarm, or a
# Kubernetes livenessProbe): a database outage would then restart this service
# in a loop, each time discarding the write buffer that exists to ride the
# outage out. There, liveness is /livez and readiness is /readyz
# (docs/decisions.md §58).
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8787/readyz || exit 1

# tsx is a runtime dependency here, not a build tool: the service executes
# TypeScript source directly. Invoking the installed binary rather than `npx`
# keeps container start offline and instant.
CMD ["node_modules/.bin/tsx", "apps/ingest/src/server.ts"]
