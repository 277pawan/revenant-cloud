FROM node:22-alpine

WORKDIR /app

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
