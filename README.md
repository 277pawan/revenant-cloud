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

## Frontend (separate repo)

```bash
cd ../revenant-cloud-web
cp .env.example .env
npm install
npm run dev
```

Web: http://localhost:5173

## Environment

| Variable | Dev value | Notes |
|----------|-----------|-------|
| `DATABASE_URL` | `postgresql://postgres:root@localhost:5432/revenant_cloud` | Control-plane DB only |
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
