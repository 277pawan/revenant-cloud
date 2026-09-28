# Revenant Cloud API

Backend control plane for fleet-wide PostgreSQL restore validation.

**Frontend:** [revenant-cloud-web](../revenant-cloud-web) · **Marketing:** [revenant-website](../revenant-website) · **Product roadmap:** [docs/REVENANT_STATUS_AND_ROADMAP.md](./docs/REVENANT_STATUS_AND_ROADMAP.md)

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

Jobs are processed by an **embedded worker** inside the API (development default).

For customer-style off-server execution, use the separate **Agent Box** app:

```bash
cd ../revenant-agent
cp agent.example.yaml agent.yaml   # token from Settings → Agent Box
npm install && npm start
```

See [RUNNERS.md](./RUNNERS.md).

## Recovery points and restores

For AWS RDS workflows, the Recovery points view discovers available manual and automated snapshots for the configured source instance and lists them newest-first. A user can choose a recovery point to restore into a new RDS instance; Revenant reads the source instance's subnet group and VPC security groups from AWS and reuses them for the restore. The configured recovery instance class is preferred, falling back to the source instance class.

Restore attempts are recorded separately from snapshots. The new RDS instance is retained in the customer's AWS account, and its status/history is available under **Recovered instances**. It is not automatically reaped because it may contain data the user wants to inspect; it continues to incur AWS charges until the customer deletes it.

Manual snapshots can be deleted from AWS through the recovery-point action. AWS does not allow individual deletion of automated snapshots, so Revenant can only hide those from the active recovery-point list; AWS retains them according to its backup retention policy. Existing verification and restore history is kept in Revenant.

Legacy verification records without an AWS snapshot ID are matched against snapshots that existed by the verification time. The resolved ID is saved and shown for review before a restore is started; if Revenant cannot make a safe match, it does not guess a snapshot.

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

### Migrations — do this after every pull (fixes 500 on billing / new features)

If the API returns **500** on `/billing/create-order` or errors like `column … does not exist` / `relation … does not exist`, the database is behind the code.

```bash
cd revenant-cloud
npm run db:migrate
# restart API: npm run dev   (or npm start)
```

**Checklist when adding a migration SQL file:**

1. Put the file in `apps/api/drizzle/` (e.g. `0020_billing_orders.sql`).
2. **Register it** in `apps/api/drizzle/meta/_journal.json` — Drizzle skips files not listed in the journal (a common “migration ran but table missing” bug).
3. Run `npm run db:migrate` from `revenant-cloud` (loads `DATABASE_URL` from `.env`).
4. Confirm DB name is `revenant_cloud` (not `revenant`) in `.env`.

Verify billing table:

```bash
psql "$DATABASE_URL" -c '\d billing_orders'
```

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
