# Phase 4 — Schedules, evidence, webhooks, audit

**Status:** complete  
**Prerequisite:** Phase 2.5 complete (agent box + workflows UI)

## Goals

| Feature | Purpose |
|---------|---------|
| **Schedules** | Cron-triggered validation runs per workflow (database/plan) |
| **Evidence vault** | Signed reports + artifacts from completed jobs |
| **Webhooks** | Notify Slack/PagerDuty on pass/fail |
| **Audit log** | Who changed what (plans, creds, team, schedules) |

## Build order

### 4.1 Schedules

- [x] `schedules` table + migration
- [x] CRUD API `/api/v1/schedules`
- [x] `next_run_at` computed on create/update (`lib/cron.ts`)
- [x] Scheduler worker (`EMBEDDED_SCHEDULER`, poll due schedules → enqueue jobs)
- [x] Schedules UI (`/schedules`)

### 4.2 Evidence vault

- [x] `evidence_artifacts` table (job_id, sha256, storage key, signed_at)
- [x] JSON report archived on job complete
- [x] Download API + vault UI (`/evidence`)

### 4.3 Webhooks

- [x] `webhook_endpoints` table per org
- [x] Dispatch on job terminal states (pass/fail/error)
- [x] Retry + delivery log (`webhook_deliveries`)
- [x] Settings → Webhooks UI (`/settings/webhooks`)

### 4.4 Audit log

- [x] `audit_events` append-only table
- [x] Logged on schedule/webhook/job mutations
- [x] Settings → Audit log UI (`/settings/audit-log`, admin)

## API conventions

- All routes under `/api/v1`, org-scoped
- Permissions: `schedules:*`, `evidence:read`, `webhooks:*`, `audit:read`
- List endpoints paginated `{ data, pagination }`

## Environment

| Variable | Default | Purpose |
|----------|---------|---------|
| `EVIDENCE_DIR` | `./data/evidence` | Filesystem storage for signed JSON |
| `EMBEDDED_SCHEDULER` | `auto` (on in dev) | Poll schedules and enqueue jobs |
| `SCHEDULER_POLL_MS` | `60000` | Scheduler interval |
