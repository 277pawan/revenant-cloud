# Phase 5 — Deploy & Docker Hub agent

**Status:** planned  
**Prerequisite:** Agent tested locally against cloud API (Phase 2.5)

## Goal

Ship a reproducible path: **build agent image → push Docker Hub → customers pull and run**; then deploy control plane (API + web) to staging.

---

## 5.1 Agent image (Docker Hub)

### Build (API URL baked at build time)

```bash
cd revenant-agent
docker build \
  --build-arg REVENANT_API_URL=https://api.yourdomain.com \
  -t yourdockerhub/revenant-agent:0.1.0 \
  -t yourdockerhub/revenant-agent:latest \
  .
```

### Test locally before push

```bash
docker run --rm -e REVENANT_RUNNER_TOKEN=rvn_xxx yourdockerhub/revenant-agent:0.1.0
# Expect: whoami OK, poll loop started
```

### Push

```bash
docker login
docker push yourdockerhub/revenant-agent:0.1.0
docker push yourdockerhub/revenant-agent:latest
```

### Customer run

```bash
docker run -d --restart unless-stopped \
  -e REVENANT_RUNNER_TOKEN=rvn_xxx \
  yourdockerhub/revenant-agent:latest
```

**Checklist**

- [ ] `docker build` with production `REVENANT_API_URL`
- [ ] `whoami` + claim/complete against staging API
- [ ] Push to Docker Hub (public or private)
- [ ] Update Services UI snippet with real image name
- [ ] Document token rotation after deploy

---

## 5.2 Control plane staging

| Component | Suggested target | Notes |
|-----------|------------------|-------|
| Postgres | RDS / Neon / self-hosted | Run `npm run db:migrate` |
| API | Fly.io / ECS / Railway | `DATABASE_URL`, `JWT_SECRET`, `MASTER_KEY` |
| Web | Static CDN or same host | `VITE_API_URL` at build time |
| TLS | Required | CORS origin = web URL |

**Env (API)**

```
DATABASE_URL=...
JWT_SECRET=...
MASTER_KEY=...   # 32-byte hex for AES-256-GCM
CORS_ORIGIN=https://app.yourdomain.com
NODE_ENV=production
```

**Checklist**

- [ ] Staging API + DB migrated (including `0005`, `0006`)
- [ ] Web build points at staging API
- [ ] Smoke: login → workflow → run → agent completes
- [ ] Disable open `/auth/register` or gate behind invite

---

## 5.3 Production hardening (before GA)

- httpOnly session cookies + CSRF
- Rate limiting on auth + runner claim
- Backup control-plane Postgres
- Monitoring (health, job failure rate, agent last_seen)
