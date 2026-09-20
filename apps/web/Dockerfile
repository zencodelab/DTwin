# Two stages: the build toolchain does not belong in the image that runs.
#
# Before this the runner was the builder — every dev dependency, the TypeScript
# compiler and the whole source tree shipped to production. `output:
# 'standalone'` in next.config.ts traces what the server actually imports,
# including the transpiled workspace packages, and only that is copied over.

FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/types/package.json ./packages/types/
COPY packages/db/package.json    ./packages/db/
COPY apps/web/package.json       ./apps/web/

RUN npm ci --workspace @dtwin/web --include-workspace-root

COPY packages/types ./packages/types
COPY packages/db    ./packages/db
COPY apps/web       ./apps/web

RUN npm run build --workspace @dtwin/web

# ---------------------------------------------------------------------- run

FROM node:22-alpine AS runner

# curl for the healthcheck below; the base image has neither curl nor wget.
RUN apk add --no-cache curl

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# `node` exists in the base image with uid 1000. Running as root is a default
# worth losing: nothing here needs to write to the filesystem.
COPY --from=builder --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=builder --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
# No `public/` to copy: this app has no static assets, and COPYing a directory
# that does not exist fails the build rather than being skipped. Add the line
# back with the directory.

USER node

EXPOSE 3000

# /login rather than /: the dashboard needs a session and answers 307, while
# the login page is the one route that is always renderable. A 200 here means
# Next is serving and its React runtime loaded.
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/login || exit 1

CMD ["node", "apps/web/server.js"]
