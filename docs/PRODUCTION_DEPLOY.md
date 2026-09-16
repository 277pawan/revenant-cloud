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

**API container must have `revenant` CLI on PATH** (or set `REVENANT_CLI_PATH`) if `EMBEDDED_RUNNER=true` — otherwise managed drills cannot run verify.

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
REVENANT_CLI_PATH=/usr/local/bin/revenant

# ─── Auth ─────────────────────────────────────────────────
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
