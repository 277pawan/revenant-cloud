# Phase 4 — Schedules, evidence, webhooks, audit

**Status:** in progress  
**Prerequisite:** Phase 2.5 complete (agent box + workflows UI)

## Goals

| Feature | Purpose |
|---------|---------|
| **Schedules** | Cron-triggered validation runs per workflow (database/plan) |
| **Evidence vault** | Signed reports + artifacts from completed jobs |
| **Webhooks** | Notify Slack/PagerDuty on pass/fail |
| **Audit log** | Who changed what (plans, creds, team, schedules) |

## Build order

### 4.1 Schedules (current)

- [x] `schedules` table + migration
- [x] CRUD API `/api/v1/schedules`
- [ ] Scheduler worker (poll `next_run_at`, enqueue jobs with `trigger=schedule`)
- [ ] Schedules UI (remove SOON badge)
- [ ] Cron preview + timezone in UI

### 4.2 Evidence vault

- [ ] `evidence_artifacts` table (job_id, sha256, storage key, signed_at)
- [ ] Generate PDF/JSON report on job complete
- [ ] Download API + vault UI

### 4.3 Webhooks

- [ ] `webhook_endpoints` table per org
- [ ] Dispatch on job terminal states
- [ ] Retry + delivery log

### 4.4 Audit log

- [ ] `audit_events` append-only table
- [ ] Middleware hook on write routes
- [ ] Settings → Audit log UI (admin)

## API conventions

- All routes under `/api/v1`, org-scoped
- Permissions: `schedules:read`, `schedules:write` (admin + executor)
- List endpoints paginated `{ data, pagination }`
