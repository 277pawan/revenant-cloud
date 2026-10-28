FROM node:22-alpine

WORKDIR /app

# redis-server + redis-cli are the proof sandbox.
#
# A Redis restore proof captures an RDB off the live server and boots a
# throwaway redis-server against that exact file. That needs the real Redis
# binaries in the image — the API has no Docker daemon to run them in, and
# asking every customer to deploy an always-on agent was never a reasonable
# price for a button in the dashboard.
RUN apk add --no-cache redis

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
