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

EXPOSE 8787
# tsx is a runtime dependency here, not a build tool: the service executes
# TypeScript source directly. Invoking the installed binary rather than `npx`
# keeps container start offline and instant.
CMD ["node_modules/.bin/tsx", "apps/ingest/src/server.ts"]
