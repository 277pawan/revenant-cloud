# Revenant — product, plans, and go-to-market

**Last updated:** 2026-09-16  
**Audience:** founders + next implementation sprint (marketing site, Razorpay, production deploy)

---

## Brutal truth (what we keep vs cut)

### Keep (launch hero)

| Item | Why |
|------|-----|
| **Developer (free)** — `revenant` CLI + GitHub Action | Zero cloud cost, proves the core value in CI. No account required. |
| **Starter (cloud)** — **1 production workflow**, managed AWS restore drill | Revenant cloud runs the drill. **No agent tokens** (API-enforced). |
| **Pro** — agent for **private Postgres only** | Agent claims **paid cloud jobs** — not a free CLI substitute. |
| **30-day trial** on Starter signup | Try the control plane before Razorpay. No card at register. |
| **Sandbox concurrency limits** (1 Starter, 3 Pro) | Real limit = concurrent restores, not “10 agents.” |
| **Evidence vault + schedules + email** on Starter | Enough for one critical DB team. |
| **Proof Composer** (schema-aware YAML) | Differentiator for validation plans. |
| **Google + GitHub SSO** | Enough for launch. |
| **Embedded/managed runner on API** | Executes Starter drills without customer infra. |

### Cut or defer (do not ship as hero)

| Item | Why |
|------|-----|
| **Agent as onboarding step #3** | Wrong story for Starter. Moved to optional Pro+ / direct Postgres. |
| **Microsoft SSO** | Removed; two providers is enough. |
| **Starter direct Postgres** | API blocks it; use Developer CLI or upgrade to Pro. |
| **Payment before trial** | Bad conversion; trial first, Razorpay on marketing site after. |
| **“Unlimited agents” marketing** | Misleading; sell workflows + concurrent sandboxes. |
| **Billing inside app (v1)** | Marketing site + Razorpay webhook → API updates org. |
| **SEO / content machine** | After real URLs and one paying customer path. |

### Honest gaps (know before cloud deploy)

1. **`revenant-agent` repo** — not in this monorepo; Docker image `277pawan/revenant-agent:latest` is referenced in UI but build/publish is a separate task (Pro+ only).
2. **Razorpay** — catalog + trial fields exist; no subscription checkout yet.
3. **Marketing website** — separate from `revenant-cloud-web` (app dashboard).
4. **Managed runner** — confirm `EMBEDDED_RUNNER` (or equivalent) enabled on API in production so Starter drills actually run without customer agent.

---

## Plan matrix

### Developer — **Free forever** (CLI / GitHub Action)

- **Not** a cloud org plan (`organizations.plan` is only `starter` | `pro` | `enterprise`).
- User never signs up for cloud unless they want the dashboard.
- **Includes:** verify, snapshot, reap, GitHub Action workflows, own AWS keys, own pipeline.
- **Does not include:** dashboard, evidence vault in cloud, schedules, team RBAC, Proof Composer UI.

### Starter — **₹999/mo** (cloud control plane)

- **30-day trial** on register / OAuth org create (`trial_ends_at`, `subscription_status=trialing`).
- **1** database workflow, **1** schedule, **3** team members.
- One restore drill at a time (same as one workflow — not a separate upsell).
- **No self-hosted agent** (`selfHostedAgent: false` — tokens blocked in API).
- **Managed drills only** (`recoveryMode=aws-rds`); no direct Postgres.
- Evidence **30 days**, audit log **30 days**.
- Integrations: email (Slack/HTTP = Pro gate on webhooks service).

### Pro — **₹4,999/mo**

- **10** workflows, **10** schedules, **15** team members.
- **3 parallel** restore drills (fleet).
- **Direct Postgres** + **self-hosted agent** (required when DB is private; still needs active Pro subscription to create/claim jobs).
- Evidence **365 days**, full audit log.
- Slack + email + HTTP integrations.

### Enterprise — **Contact us**

- Custom limits, SSO packaging, SLAs (sales-led).

---

## Execution paths (internal)

```
1. Managed sandbox (Starter hero)
   User AWS keys → API embedded runner → RDS snapshot restore → CLI verify → evidence

2. Developer CLI / GH Action (free)
   User machine / CI → same verify logic → no cloud org

3. Optional agent (Pro+, private VPC)
   Customer Docker agent → claims jobs for direct Postgres workflows
```

**Multiple instances** = multiple **workflows over time**, capped by **sandbox concurrency** — not “run 10 agents at once” on Starter.

---

## Implementation checklist (this repo)

### Done / in progress

- [x] `packages/shared/src/plans.ts` — Developer catalog + cloud limits
- [x] Migration `0013_org_trial_billing.sql` — trial + subscription_status
- [x] `plan-limits.ts` — subscription, sandbox concurrency, recovery mode
- [x] Dashboard onboarding — AWS keys → first drill → optional agent
- [x] Web trial banner + Starter-only AWS wizard default
- [x] Public catalog `listCatalogPlans()` + `billing.starterTrialDays`

### Before production deploy

- [ ] Run `npm run db:migrate` in `revenant-cloud` (0013)
- [ ] Set production env: `OAUTH_REDIRECT_BASE_URL`, `PUBLIC_APP_URL`, `COOKIE_SECURE=true`
- [ ] Enable managed runner on API for sandbox jobs
- [ ] OAuth redirect URIs in Google/GitHub consoles for prod domains
- [ ] SMTP for prod (password reset, alerts)
- [ ] Deploy API + web + Postgres (RDS or managed)
- [ ] Smoke: register → trial banner → add AWS DB → run drill → evidence

### Agent Docker (Pro+, secondary)

- [ ] Create/publish `revenant-agent` image (separate repo)
- [ ] Document `REVENANT_RUNNER_TOKEN` + baked `REVENANT_API_URL` for prod
- [ ] Push to Docker Hub / GHCR; set `VITE_AGENT_IMAGE` on web build

---

## Next project: marketing website + Razorpay

**Separate repo or `revenant-website`** — static/Next marketing site, not the logged-in app.

### Pages

1. **Home** — hero = “Prove RDS backups actually recover” (not “deploy agents”).
2. **Pricing** — Developer / Starter / Pro / Enterprise from `GET /api/v1/public/catalog` (or static mirror).
3. **Docs links** — CLI install, GitHub Action, cloud signup CTA.
4. **Checkout** — Starter & Pro via Razorpay Subscriptions or Orders.

### Razorpay integration

1. Razorpay account + KYC; create Plans matching `priceInr` (999, 4999).
2. Marketing site: “Start trial” → `app.revenant.dev/register` (no payment).
3. “Subscribe” / trial ending → Razorpay checkout → webhook `POST /api/v1/billing/razorpay/webhook`:
   - Verify signature
   - Set `organizations.subscription_status = active`
   - Store `razorpay_subscription_id` (new column, future migration)
4. `past_due` / `canceled` → `assertSubscriptionActive` blocks new drills (existing behavior).

### Env (future)

```
RAZORPAY_KEY_ID=
RAZORPAY_KEY_SECRET=
RAZORPAY_WEBHOOK_SECRET=
VITE_MARKETING_BILLING_URL=https://revenant.dev/pricing
```

---

## Suggested URLs (production)

| Surface | URL |
|---------|-----|
| Marketing | `https://revenant.dev` |
| App (dashboard) | `https://app.revenant.dev` |
| API | `https://api.revenant.dev` |

Update OAuth, CORS, and `PUBLIC_APP_URL` together when DNS is live.

---

## Docker vs free CLI (why agent is not a bypass)

| Path | Cloud account? | Pays Revenant? | Where CLI runs | What you get |
|------|----------------|----------------|----------------|--------------|
| **Developer CLI** | No | No | Your laptop / GitHub Actions | Restore proof in CI — YAML in git |
| **Starter cloud** | Yes | After trial | **Revenant servers** (embedded runner) | Dashboard, evidence, schedules, composer |
| **Pro agent** | Yes | Yes | **Your VPC** (Docker/npm) | Same cloud features + private DB reachability |

The Docker image includes the CLI binary, but the agent **only works with a dashboard-issued token** tied to a **paid org**. Trial end → `assertSubscriptionActive` blocks new jobs → agent idles.

**Starter cannot issue tokens** — so Docker is not an escape hatch on the cheapest cloud tier.

## What to tell customers

**Free path:** “Use the CLI or GitHub Action in your repo — no Revenant account.”

**Cloud path:** “Sign up for a 30-day Starter trial. Add AWS keys, define a validation plan, run a managed restore drill. We spin up a sandbox, verify, tear down, and store evidence. No Docker on your side.”

**Pro path:** “Multiple databases, private Postgres, optional agent in your VPC, Slack alerts, longer evidence retention.”
