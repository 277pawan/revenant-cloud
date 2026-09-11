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

### Phase 0 — ✅ done

- [x] Monorepo, health, auth, login UI, app shell

### Phase 1 — ✅ complete (control-plane config)

- [x] Layered API: `validations/` → `services/` → `controllers/` → `routes/v1/`
- [x] `/api/v1` version prefix
- [x] `databases` + `database_credentials` (AES-256-GCM) + CRUD
- [x] Paginated list GETs (`page` / `pageSize` → `{ data, pagination }`)
- [x] RBAC: `ROLE_PERMISSIONS` + `requirePermission`
- [x] Databases list UI + add wizard (react-hook-form + zod)
- [x] `validation_plans` (yaml text per database) + UI
- [x] Team invite / list / role update / remove (admin)

### Phase 2 — ✅ complete (jobs + execution)

- [x] `jobs` + `job_results` tables
- [x] Trigger job API + paginated list + job detail
- [x] Runner claim/complete API
- [x] **Embedded worker** on `npm run dev` (no separate runner terminal required)
- [x] Org-scoped runners (agent | ci) for self-hosted / CI
- [x] Wire execution to real `revenant verify` when CLI is available (`REVENANT_CLI_PATH` or sibling binary)
- [x] Monaco YAML editor + format + checks preview (CLI-shaped default plan)
- [x] Jobs list + job detail UI (Simulated badge when metadata fallback)
- [ ] Polish job detail to Figma (evidence download later)

### Phase 3

- [ ] KMS / key rotation for `MASTER_KEY` (encryption already shipped in Phase 1)
- [ ] AWS snapshot + restore flow via runner
- [ ] Store AWS keys in encrypted credential blob

### Phase 4

- [ ] Schedules, evidence vault, webhooks, audit log

---

## RBAC — how one website serves a whole team

Same login page, same dashboard. After JWT auth, every request carries `role` + `organizationId`.

| Role | Can do |
|------|--------|
| **admin** | Full: databases write, credentials, invite team, run jobs |
| **executor** | Read databases, run jobs (ops engineer) |
| **viewer** | Read-only (manager / auditor) |

**Multi-tenancy:** every query filters by `organizationId` from the JWT.  
**Authorization:** `requirePermission("databases:write")` etc. — see `packages/shared` `ROLE_PERMISSIONS`.

Later: `POST /api/v1/team/invite` (admin only) creates a user in the **same org** with role `executor` or `viewer`. They log into the same website; sidebar/actions hide based on role.

---

## API layout (do not put full `/api/v1/...` in every handler)

```
apps/api/src/
  validations/     # Zod schemas only
  services/        # DB + business logic
  controllers/     # HTTP request/response
  routes/v1/       # Thin route wiring under prefix /api/v1
  middleware/      # requireAuth, requirePermission
  lib/             # crypto, password, session, errors
```

Routes register as `POST /auth/login` inside the `/api/v1` plugin → public URL `/api/v1/auth/login`.

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
