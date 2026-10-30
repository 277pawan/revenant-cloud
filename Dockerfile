FROM node:22-alpine

WORKDIR /app

# ─── The Redis proof sandbox ─────────────────────────────────────────────────
#
# A Redis restore proof captures data off the live server and replays it into
# a throwaway redis-server. That needs the real Redis binaries in the image:
# the API has no Docker daemon to run them in, and asking every customer to
# deploy an always-on agent was never a reasonable price for a button in the
# dashboard.
#
# The version matters. A Redis server can read an older data format but
# never a newer one, so the sandbox must be at least as new as the customer's
# Redis — otherwise a Redis 8 cache hands back a payload the sandbox cannot
# load ("DUMP payload version or checksum are wrong"), which looks exactly
# like a broken backup and is not one.
#
# So the sandbox ships Redis 8, the newest format we can read. `apk add
# redis` (7.2) is kept as the fallback for images built on older bases.
FROM redis:8-alpine AS redis-binaries

FROM node:22-alpine

WORKDIR /app

RUN apk add --no-cache redis

COPY --from=redis-binaries /usr/local/bin/redis-server /usr/local/bin/redis-server-8
COPY --from=redis-binaries /usr/local/bin/redis-cli /usr/local/bin/redis-cli-8

# Workspace manifests (monorepo: api + shared)
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/

RUN npm ci

COPY packages/shared packages/shared
COPY apps/api apps/api

RUN npm run build

ENV NODE_ENV=production
WORKDIR /app/apps/api

EXPOSE 8080

CMD ["npm", "start"]
