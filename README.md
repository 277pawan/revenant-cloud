# Revenant Cloud API

Backend control plane for fleet-wide PostgreSQL restore validation.

**Frontend is a separate repo:** [revenant-cloud-web](../revenant-cloud-web)

## Local setup (no Docker)

```bash
# API
cd revenant-cloud
cp .env.example .env
# Edit JWT_SECRET: openssl rand -base64 32

bash scripts/create-db.sh
npm install
npm run db:migrate
npm run dev
```

API: http://localhost:8080/health

## Database commands (from repo root)

| Command | What it does |
|---------|----------------|
| `npm run db:create` | Create local `revenant_cloud` database |
| `npm run db:generate` | Diff `schema.ts` → new SQL file in `apps/api/drizzle/` |
| `npm run db:migrate` | Apply pending migrations |
| `npm run db:drop` | **DEV** — drop all public tables + migration history |
| `npm run db:reset` | **DEV** — `db:drop` then `db:migrate` (clean slate) |
| `npm run db:studio` | Open Drizzle Studio |

Drizzle does **not** auto-generate down/revert SQL. Locally use `db:reset`. In prod, write a new forward migration that undoes the change.

## Frontend (separate repo)

```bash
cd ../revenant-cloud-web
cp .env.example .env
npm install
npm run dev
```

Web: http://localhost:5173

## Environment file location

Put `.env` at the **repo root** (`revenant-cloud/.env`):

```bash
cp .env.example .env
```

Optional override: `apps/api/.env` (loaded after root).

The API loads env in `apps/api/src/config/env.ts` — not from a separate `env.js` file.
Variables are read from `.env` → `process.env` → validated by Zod.

| Variable | Dev value | Notes |
|----------|-----------|-------|
| `DATABASE_URL` | `postgresql://postgres:root@localhost:5432/revenant_cloud` | Control-plane DB only |
| `JWT_SECRET` | `openssl rand -base64 32` | Min 32 chars |
| `MASTER_KEY` | `openssl rand -base64 32` | Exactly 32 bytes base64 — encrypts DB passwords |
| `ALLOW_OPEN_REGISTRATION` | `true` | Set `false` before public deploy |
| `COOKIE_SECURE` | `false` | `true` when on HTTPS |
| `CORS_ORIGIN` | `http://localhost:5173` | Web app URL |

## Repos

| Repo | Purpose |
|------|---------|
| **revenant-cloud** | API + Drizzle + auth (this repo) |
| **revenant-cloud-web** | React dashboard |
| **revenant-cli** | Open-source `revenant` CLI engine |
| **revenant-action** | GitHub Action |

See [FOUNDATION.md](./FOUNDATION.md) for build order and security rules.

## Docker (later)

When Docker is installed: `docker compose up -d` and use port 5433 from compose file.
