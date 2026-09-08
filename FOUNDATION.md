# Foundation — read this before writing feature code

## Brutal truth

This is **not** a product yet. It is a **correct skeleton**:

- Real multi-tenant tables (`organizations` → `users`)
- Real auth (bcrypt + JWT), not mocked
- Shared types so API and web do not drift

What you **do not** have yet (and must not pretend you do):

- Encrypted credential storage
- Job runner that executes `revenant` CLI
- RBAC enforcement on every route
- Rate limiting, audit log, SSO
- Production deployment, backups, monitoring

Shipping any of the above without design review will create security debt.

---

## Repos (split on purpose)

| Repo | Contents |
|------|----------|
| **revenant-cloud** | API only (`apps/api` + `packages/shared`) |
| **revenant-cloud-web** | React dashboard only |

Do not merge them back into one monorepo — different deploy targets and release cycles.

| Decision | Choice | Why |
|----------|--------|-----|
| Repo | **Separate `revenant-cloud`** | SaaS lifecycle ≠ open-source CLI |
| API | **Fastify + TypeScript** | Schema-friendly, fast, boring |
| ORM | **Drizzle** | Typed SQL, migrations in repo, easy to grep schema |
| Web | **Vite + React + Tailwind** | Matches Figma ops console; shadcn components added incrementally |
| Auth v0 | **Real JWT login** | Matches Figma; no fake dev-only auth |
| Control-plane DB | **Postgres on 5433** | Never confuse with customer RDS |

---

## Two databases — never mix them

| Database | Purpose | Where |
|----------|---------|-------|
| **Control-plane Postgres** | Orgs, users, jobs metadata, encrypted cred blobs | `docker-compose.yml` / `DATABASE_URL` |
| **Customer Postgres / RDS** | What Revenant validates | Connected via credentials + CLI |

If you point the control plane at `database-1`, you are doing it wrong.

---

## Multi-tenancy rule

Every new table **must** include `organization_id` and every query **must** filter by the authenticated user's org.

No exceptions. Cross-tenant leaks are company-ending bugs.

---

## Build order (do not skip)

### Phase 0 — ✅ you are here

- [x] Monorepo, health, auth, login UI, app shell

### Phase 1 — next

- [ ] `databases` table + CRUD API + list UI
- [ ] `validation_plans` (store yaml text per database)
- [ ] RBAC middleware (`admin` / `executor` / `viewer`)

### Phase 2

- [ ] `jobs` + `job_results` tables
- [ ] Runner process: poll API → spawn `revenant verify` → POST results
- [ ] Job detail page (Figma)

### Phase 3

- [ ] `credentials` table with **AES-256-GCM** encryption at rest
- [ ] KMS or `MASTER_KEY` env (never commit)
- [ ] AWS snapshot + restore flow via runner

### Phase 4

- [ ] Schedules, evidence vault, webhooks, audit log

---

## Security gaps to fix before production

1. **`/auth/register` is open** — disable or gate behind invite token before public launch
2. **JWT in localStorage** — acceptable for v0; move to httpOnly cookies + CSRF for production
3. **No HTTPS enforcement** — required in prod
4. **No password reset / email verify** — required for real SaaS
5. **Runner will hold decrypted creds in memory** — design short-lived injection, never log

---

## What we intentionally did NOT choose yet

| Topic | Status |
|-------|--------|
| Queue | PostgreSQL `jobs` table first; Redis/Temporal later if needed |
| Hosting | Not decided (Fly.io, AWS ECS, Railway, etc.) |
| Billing | Not in schema yet |
| SSO | After email/password works |

---

## When in doubt

Ask: *"Does this belong in the control plane DB or the customer's DB?"*  
If unsure, stop and document before coding.
