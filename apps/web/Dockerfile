FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/types/package.json ./packages/types/
COPY packages/db/package.json    ./packages/db/
COPY apps/web/package.json       ./apps/web/

RUN npm ci --workspace @dtwin/web --include-workspace-root

COPY packages/types ./packages/types
COPY packages/db    ./packages/db
COPY apps/web       ./apps/web

WORKDIR /app/apps/web
RUN npm run build

EXPOSE 3000
CMD ["npm", "run", "start"]
