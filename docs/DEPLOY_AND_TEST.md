# Deploy agent image + end-to-end test checklist

## Pricing source of truth

Edit **one file** for backend + public API:

`packages/shared/src/plans.ts`

```ts
export const STARTER_TRIAL_DAYS = 30;
export const STARTER_PRICE_INR = 999;
export const PRO_PRICE_INR = 4999;
```

After changes: `npm run build -w @revenant/shared` (or `npm run build` at repo root).

- `GET /api/v1/public/catalog` — marketing can mirror from here
- `GET /api/v1/billing/subscription` — logged-in usage + limits
- All plan limit errors use friendly copy from `apps/api/src/lib/plan-messages.ts`

Frontend pricing: update manually in `revenant-cloud-web` when you change amounts.

---

## Starter trial (backend behavior)

| Event | What happens |
|-------|----------------|
| Register / OAuth new org | `plan=starter`, `subscription_status=trialing`, `trial_ends_at=now+30d` |
| During trial | Full Starter features |
| After 30 days (no Razorpay yet) | `assertSubscriptionActive` blocks new drills |
| Razorpay (later) | Webhook sets `subscription_status=active` |

---

> **Full production guide (env backend vs frontend, OAuth consoles, smoke test):**  
> [`docs/PRODUCTION_DEPLOY.md`](./PRODUCTION_DEPLOY.md)

## Docker Hub — publish agent

**Prerequisites**

1. Docker Hub account (`277pawan` or your org)
2. Production API URL (or staging), e.g. `https://api.revenant.dev`
3. `revenant-cli` sibling repo at `../revenant-cli`

**Commands**

```bash
cd revenant-agent
docker login

REVENANT_API_URL=https://api.revenant.dev \
  ./scripts/publish-agent-image.sh 277pawan/revenant-agent:0.1.0

docker push 277pawan/revenant-agent:0.1.0
docker push 277pawan/revenant-agent:latest
```

**Web build env**

```
VITE_AGENT_IMAGE=277pawan/revenant-agent:latest
```

**Customer run (Pro, private Postgres only)**

```bash
docker run -d --restart unless-stopped \
  -e REVENANT_RUNNER_TOKEN=rvn_... \
  277pawan/revenant-agent:latest
```

---

## Test order (before marketing website)

Do this **before** the marketing site — the site will call `GET /api/v1/public/catalog`.

### 1. Local API + DB

```bash
cd revenant-cloud
npm run db:migrate
npm run dev
```

### 2. Plan + trial

- [ ] Register → `GET /api/v1/billing/subscription` shows `trialing`, 30 days, `workflows: 0/1`
- [ ] `GET /api/v1/public/catalog` shows `priceInr: 999` and `4999` from shared file

### 3. Starter limits

- [ ] Add 1 database (AWS RDS) → OK
- [ ] Add 2nd database → friendly `PLAN_LIMIT` workflow message
- [ ] Run drill → OK (embedded runner)
- [ ] Issue agent token → blocked on Starter
- [ ] Direct Postgres mode → blocked on Starter

### 4. Manual Pro grant (you, from DB)

Limits are read from `organizations.plan` on **every API request** — no redeploy needed.

```sql
-- Find org
SELECT id, name, plan, subscription_status, trial_ends_at FROM organizations;

-- Grant Pro + keep access if trial already ended
UPDATE organizations
SET
  plan = 'pro',
  subscription_status = 'active'
WHERE id = 'YOUR_ORG_UUID';
```

**UI:** User refreshes the page (or switches back to the tab — app re-fetches `/me`). Sidebar shows **Agent (Pro+)** and token UI appears for **direct Postgres** workflows only.

**Revert to Starter:**

```sql
UPDATE organizations SET plan = 'starter' WHERE id = 'YOUR_ORG_UUID';
```

### 5. Trial expiry (dev)

Manually set `trial_ends_at` in DB to yesterday → run drill → `SUBSCRIPTION_INACTIVE` friendly message.

### 6. Pro (after manual grant above)

- [ ] Up to 10 workflows
- [ ] 3 parallel drills (start 3, 4th should fail with friendly message)
- [ ] Agent token issue works
- [ ] AWS drills still managed (no Docker required)

### 7. Agent Docker (optional)

- [ ] Publish image with real API URL
- [ ] Pro org + direct Postgres workflow + token → container claims job → evidence in cloud

---

## Marketing website — when?

**After** steps 1–5 pass on a staging/production API URL.

Marketing site needs:

- Static pricing (copy from catalog API or `plans.ts`)
- CTA → `app.../register` (30-day trial, no payment)
- Razorpay checkout (next sprint) → webhook activates `subscription_status`
