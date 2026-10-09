# Production deploy — 4 steps (copy-paste ready)

Replace `revenant.dev` with your real domain everywhere below.

| Service | URL example |
|---------|-------------|
| **API** (backend) | `https://api.revenant.dev` |
| **App** (dashboard) | `https://app.revenant.dev` |
| **Marketing** (later) | `https://revenant.dev` |

---

## Step 1 — Docker Hub login + publish agent image

Only needed for **Pro customers with private Postgres**. Starter/Pro AWS drills do **not** need this image on the customer side.

```bash
docker login
# Username: 277pawan
# Password: your Docker Hub token (not GitHub password)

cd /path/to/revenant-agent

# Bakes API URL into image — customers only pass REVENANT_RUNNER_TOKEN later
REVENANT_API_URL=https://api.revenant.dev \
  ./scripts/publish-agent-image.sh 277pawan/revenant-agent:0.1.0

docker push 277pawan/revenant-agent:0.1.0
docker push 277pawan/revenant-agent:latest
```

Requires sibling repo: `../revenant-cli` (CLI is compiled inside the image).

---

## Step 2 — Deploy API + database

1. Postgres (RDS, Supabase, etc.) → get `DATABASE_URL`
2. Run migrations once:
   ```bash
   cd revenant-cloud
   DATABASE_URL='postgresql://...' npm run db:migrate
   ```
3. Start API with the **backend `.env`** from Step 3 (Railway, Fly, ECS, VPS + systemd, etc.)
4. API must be reachable at `https://api.revenant.dev` with HTTPS

When `EMBEDDED_RUNNER=true`, Cloud Run downloads the private CLI release using `REVENANT_CLI_GITHUB_TOKEN`. This is one service-level distribution credential, not a customer database credential. Drill DB passwords and AWS credentials remain encrypted per database and are injected only into that database's job.

---

## Step 3 — Environment variables (backend vs frontend)

### A) BACKEND only — `revenant-cloud/.env`

File on the **API server** (never commit real secrets). Copy from `.env.example`.

```bash
# ─── Required ─────────────────────────────────────────────
DATABASE_URL=postgresql://USER:PASS@HOST:5432/revenant_cloud
NODE_ENV=production
API_PORT=8080
API_HOST=0.0.0.0

JWT_SECRET=PASTE_OUTPUT_OF_openssl_rand_-base64_48
JWT_EXPIRES_IN=7d
MASTER_KEY=PASTE_OUTPUT_OF_openssl_rand_-base64_32
RUNNER_TOKEN=PASTE_OUTPUT_OF_openssl_rand_-base64_24

# ─── URLs (your real domains) ─────────────────────────────
PUBLIC_APP_URL=https://app.revenant.dev
CORS_ORIGIN=https://app.revenant.dev,https://revenant.dev
PUBLIC_MARKETING_URL=https://revenant.dev

# Cookies — HTTPS required in production
COOKIE_SECURE=true
# Optional: share cookie between app.revenant.dev + revenant.dev
# COOKIE_DOMAIN=.revenant.dev

# ─── Managed drills (Starter + Pro AWS) ───────────────────
EMBEDDED_RUNNER=true
EMBEDDED_SCHEDULER=true
```

Apply migration `0024_recovery_ttl_policy` through the normal database migration step before deploying the API version that uses these columns. It preserves enabled recovery drills for existing AWS databases; newly registered AWS databases start disabled until explicitly enabled in **Recovery operations**.

Revenant-created temporary restore instances and full-drill snapshots are tagged with `ManagedBy=Revenant`, `Purpose=RecoveryValidation`, `DatabaseId`, `RunId`, and (when auto-delete is enabled) `ExpiresAt`. Automatic deletion is **off by default**. Set a per-database retention in **Recovery operations** to expire Revenant-created resources; leave it off to retain them indefinitely. Resources already created with an expiry retain that expiry unless they are reconciled while the database retention setting is disabled. Resources created without an expiry receive one starting from the next reconciliation after auto-delete is enabled. The source database and AWS automated snapshots are never deleted.

An additional, separately confirmed option allows deletion of non-Revenant **manual snapshots for that database's configured source** after the selected retention duration. Existing manual snapshots older than that duration can be deleted at the next reconciliation. Do not enable it unless deleting those customer-created snapshots is intended. It never deletes the source database or AWS automated snapshots.

Cloud Run is deployed with zero minimum instances, so its embedded schedule poller is not reliable for cleanup: the API may scale to zero between requests. To avoid paying for Cloud Scheduler, use the included GitHub Actions workflow, which calls the API every five minutes.

```text
https://YOUR_API/api/v1/internal/recovery/reconcile
Authorization: Bearer <RECOVERY_RECONCILE_TOKEN>
```

Generate a strong random token (for example, `openssl rand -hex 32`), store it in Secret Manager as `RECOVERY_RECONCILE_TOKEN`, and configure the API to read that secret. The deploy workflow maps the secret to the API environment; create the secret before deploying.

For the free GitHub Actions option, add the same token in the repository under **Settings → Secrets and variables → Actions → New repository secret**, named `RECOVERY_RECONCILE_TOKEN`. Deploy the API, then run **Actions → Reconcile expired recovery resources → Run workflow** once to verify it. It will then run every five minutes. GitHub Actions is free for public repositories and includes a monthly allowance for private repositories; use beyond the private-repository allowance may incur charges, and scheduled runs can be delayed briefly.

The endpoint scans Revenant-owned resources by exact ownership/purpose/database/run/expiry tags, and scans customer manual snapshots only for databases where the separate opt-in is enabled. It waits for AWS deletion confirmation and reports per-database errors. The AWS credentials saved for the database must also allow `rds:DescribeDBSnapshots` and `rds:DeleteDBSnapshot`; AWS permission errors are reported by the workflow.

Cloud Scheduler is an optional alternative. For it, create a job that calls the authenticated endpoint every five minutes:

```bash
gcloud scheduler jobs create http revenant-recovery-reconcile \
  --location=asia-south1 \
  --schedule="*/5 * * * *" \
  --time-zone="Etc/UTC" \
  --uri="https://YOUR_API/api/v1/internal/recovery/reconcile" \
  --http-method=POST \
  --update-headers="Authorization=Bearer YOUR_TOKEN" \
  --attempt-deadline=30m
```

Each database has its own retention duration in Recovery Operations; there is no platform-wide retention cap. The duration is stored as a whole number of minutes (minimum 10, maximum 2,147,483,647 due to the database integer type). Retention must still be enabled per database. Longer retention keeps AWS snapshots and instances around longer and may increase AWS storage charges. If a run is still active and sending heartbeats when its expiry passes, reconciliation extends the expiry in ten-minute increments so it does not interrupt a legitimate restore or validation. A finished or stale Revenant-created resource is eligible after its expiry plus the ten-minute grace period.

Create a fine-grained GitHub token restricted to `277pawan/revenant-cli` with **Contents: Read-only** and store it in Google Cloud Secret Manager under `REVENANT_CLI_GITHUB_TOKEN`. Do not put this token in a customer GitHub repository or commit it. Grant Secret Manager Secret Accessor to both the Cloud Run runtime service account and the GitHub deploy identity. The deploy workflow maps the Secret Manager version `latest` to the `REVENANT_CLI_GITHUB_TOKEN` environment variable.

Also grant Secret Manager access to `RECOVERY_RECONCILE_TOKEN` for the Cloud Run runtime service account and GitHub deploy identity. Create this secret before the first deployment that includes the recovery reconciliation secret mapping.

For a manual Cloud Run update, bind the existing secret with:

```bash
gcloud run services update revenant-api \
  --region asia-south1 \
  --update-secrets=REVENANT_CLI_GITHUB_TOKEN=REVENANT_CLI_GITHUB_TOKEN:latest,RECOVERY_RECONCILE_TOKEN=RECOVERY_RECONCILE_TOKEN:latest
```

If the private release cannot be downloaded, production drills fail instead of returning a metadata-only pass.

### Auth

ALLOW_OPEN_REGISTRATION=true

# ─── Google OAuth (backend secrets — NOT in frontend) ─────
OAUTH_GOOGLE_CLIENT_ID=123....apps.googleusercontent.com
OAUTH_GOOGLE_CLIENT_SECRET=GOCSPX-...
OAUTH_GITHUB_CLIENT_ID=...
OAUTH_GITHUB_CLIENT_SECRET=...
OAUTH_REDIRECT_BASE_URL=https://api.revenant.dev

# ─── Email (password reset, alerts, weekly digest) ────────
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=you@gmail.com
SMTP_PASS=your-gmail-app-password
SMTP_FROM=you@gmail.com
SMTP_SECURE=false

# ─── Proof Composer (optional) ────────────────────────────
MISTRAL_API_KEY=sk-or-v1-...
MISTRAL_API_URL=https://openrouter.ai/api/v1/chat/completions
MISTRAL_MODEL=mistralai/mistral-small-3.2-24b-instruct

EVIDENCE_DIR=/var/lib/revenant/evidence
```

Generate secrets:

```bash
openssl rand -base64 32   # MASTER_KEY
openssl rand -base64 48   # JWT_SECRET
openssl rand -base64 24   # RUNNER_TOKEN
```

### B) FRONTEND only — `revenant-cloud-web/.env.production`

Used at **`npm run build`** time. Vite bakes these into the static JS bundle.

Create `revenant-cloud-web/.env.production`:

```bash
# Where the browser calls the API (must match CORS_ORIGIN on backend)
VITE_API_URL=https://api.revenant.dev

# Docker image name shown on Pro agent page (after Step 1 push)
VITE_AGENT_IMAGE=277pawan/revenant-agent:latest

# Upgrade link on trial banner (marketing site pricing page — later)
VITE_MARKETING_BILLING_URL=https://revenant.dev/pricing
```

Build + deploy static files to `app.revenant.dev`:

```bash
cd revenant-cloud-web
npm run build
# Upload dist/ to S3+CloudFront, Vercel, Netlify, nginx, etc.
```

### C) What goes WHERE (quick reference)

| Variable | Backend `.env` | Frontend `.env.production` | Google/GitHub console |
|----------|------------------|----------------------------|------------------------|
| `DATABASE_URL` | ✅ | ❌ | ❌ |
| `JWT_SECRET` | ✅ | ❌ | ❌ |
| `MASTER_KEY` | ✅ | ❌ | ❌ |
| `RUNNER_TOKEN` | ✅ | ❌ | ❌ |
| `EMBEDDED_RUNNER` | ✅ | ❌ | ❌ |
| `EMBEDDED_SCHEDULER` | ✅ | ❌ | ❌ |
| `OAUTH_*_SECRET` | ✅ | ❌ | ❌ |
| `OAUTH_*_CLIENT_ID` | ✅ | ❌ | ✅ (public client id) |
| `OAUTH_REDIRECT_BASE_URL` | ✅ | ❌ | ✅ (redirect URI) |
| `SMTP_*` | ✅ | ❌ | ❌ |
| `PUBLIC_APP_URL` | ✅ | ❌ | ❌ |
| `CORS_ORIGIN` | ✅ | ❌ | ❌ |
| `VITE_API_URL` | ❌ | ✅ | ❌ |
| `VITE_AGENT_IMAGE` | ❌ | ✅ | ❌ |
| `VITE_MARKETING_BILLING_URL` | ❌ | ✅ | ❌ |

**Rule:** If it starts with `VITE_` → frontend build only. Everything else → backend server only.

---

## Step 4 — OAuth consoles + smoke test (do this after deploy)

### 4a) Google Cloud Console → OAuth client

**Authorized JavaScript origins**

```
https://app.revenant.dev
https://api.revenant.dev
```

**Authorized redirect URIs** (API callback only — not the app URL)

```
https://api.revenant.dev/api/v1/auth/oauth/google/callback
```

### 4b) GitHub → Settings → Developer settings → OAuth App

| Field | Value |
|-------|--------|
| Homepage URL | `https://app.revenant.dev` |
| Authorization callback URL | `https://api.revenant.dev/api/v1/auth/oauth/github/callback` |

Put **Client ID** + **Client secret** in backend `.env` only.

### 4c) Smoke test checklist (production)

```bash
# API health
curl -s https://api.revenant.dev/api/v1/health

# Public catalog (marketing can use this)
curl -s https://api.revenant.dev/api/v1/public/catalog | head
```

In browser at `https://app.revenant.dev`:

- [ ] Register with email → dashboard loads, trial banner shows 30 days
- [ ] Google login (popup) → lands on dashboard
- [ ] GitHub login (popup) → lands on dashboard
- [ ] Forgot password email arrives (SMTP)
- [ ] Add AWS RDS database → run drill from Workflows → job completes
- [ ] Evidence vault shows report
- [ ] Starter: no “Agent (Pro+)” in sidebar
- [ ] Manual Pro in DB → refresh → agent page appears for direct Postgres only

### 4d) Agent image sanity (optional)

```bash
docker run --rm \
  -e REVENANT_RUNNER_TOKEN=rvn_TEST_INVALID \
  277pawan/revenant-agent:latest
# Should connect to https://api.revenant.dev (baked in) and fail auth — proves URL is correct
```

---

## Deploy order (recommended)

```
1. Postgres + migrate
2. Backend .env + start API (https://api.revenant.dev)
3. Frontend .env.production + build + deploy (https://app.revenant.dev)
4. Google + GitHub OAuth consoles (Step 4a–4b)
5. Smoke test (Step 4c)
6. Docker agent push (Step 1) — only when you need Pro private-DB customers
7. Marketing site (later) — reads /public/catalog
```

---

## Local vs production diff

| Setting | Local dev | Production |
|---------|-----------|------------|
| `VITE_API_URL` | `http://localhost:8080` | `https://api.revenant.dev` |
| `PUBLIC_APP_URL` | `http://localhost:5173` | `https://app.revenant.dev` |
| `OAUTH_REDIRECT_BASE_URL` | `http://localhost:8080` | `https://api.revenant.dev` |
| `COOKIE_SECURE` | `false` | `true` |
| `EMBEDDED_RUNNER` | `auto` (on) | `true` |
| Google redirect | `http://localhost:8080/api/v1/auth/oauth/google/callback` | `https://api.revenant.dev/api/v1/auth/oauth/google/callback` |
