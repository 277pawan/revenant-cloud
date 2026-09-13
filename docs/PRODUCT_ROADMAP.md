# Product roadmap — from engine to “Tuesday morning” product

**Goal:** Make the statement *“you haven’t built the reason a busy human opens it on Tuesday”* **wrong**.

---

## What we shipped (this sprint)

- **Dashboard hero** — DR posture headline, not Phase 1 placeholder text
- **Fleet table** — per-workflow health, last RTO, last run, drill links
- **KPIs** — 7-day pass rate, avg RTO, 24h failures, evidence count
- **Onboarding checklist** — 6 steps to first restore proof
- **Plan tiers defined** — Starter / Pro / Enterprise (UI + `organizations.plan` field)
- **`GET /api/v1/dashboard/overview`** — real aggregated data

---

## Plan tiers (pricing intent — not billing yet)

| Plan | Price (INR) | Who it's for |
|------|-------------|--------------|
| **Starter** | ₹999/mo | One critical DB, prove restore works |
| **Pro** | ₹4,999/mo | Small team, multiple workflows, AWS drills |
| **Enterprise** | Custom | SSO, compliance, unlimited |

**Enforcement:** limits live in `packages/shared/src/plans.ts` — wire API guards when Razorpay/Stripe is ready.

**Future:** marketing website + SSO → login passes `organizationPlan` from billing (same JWT claim shape we use today).

---

## Checklist to make the product “worth ₹100” (and global)

### A. First 30 minutes (trial excitement)

- [x] Dashboard answers “are we OK?” at a glance
- [x] Onboarding checklist
- [ ] **One-click “Full DR drill”** (snapshot → verify → reap) from UI
- [ ] **Sample workflow template** (import freetier YAML)
- [ ] Hosted staging URL (Phase 5)

### B. Proof people can show their boss

- [x] Evidence vault + download
- [ ] **PDF / share link** from evidence
- [ ] Slack alert with RTO + pass/fail (test Slack integration)
- [ ] Email report already works — polish template

### C. Habit (why they open every week)

- [x] Schedules with friendly UI (no cron typing)
- [x] Fleet health red/yellow/green
- [ ] **Weekly digest email** (“3/3 workflows passed”)
- [ ] Trend chart: RTO over last 30 days

### D. Trust (before taking money)

- [ ] Gate `/register` (invite-only)
- [ ] Password reset
- [ ] Enforce plan limits (DB count, schedules)
- [ ] Razorpay or Stripe (even ₹100 validates willingness to pay)

### E. Global

- [ ] Phase 5 deploy (API + web + agent Docker)
- [ ] Marketing site + docs
- [ ] SSO (website + app) → plan on login
- [ ] HTTPS, backups, monitoring

---

## Tomorrow (your call)

1. **Docker / agent** (Phase 5 start)
2. **Full DR drill button** (biggest excitement gap after dashboard)
3. **Billing stub** — Razorpay test mode + upgrade CTA

---

## Honest milestone

> **One paying user at ₹999 proves more than six more admin screens.**

Build toward that: dashboard → drill → evidence → alert → pay.
