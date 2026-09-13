# Phase 5 — Deploy & Docker Hub agent

**Status:** 5.1 in progress (agent image includes Go CLI)  
**Prerequisite:** Agent tested locally against cloud API (Phase 2.5)

## Goal

**Important first:** reproducible **agent image with `revenant` CLI inside** → local Docker smoke → Docker Hub.  
**Later:** deploy control plane (API + web) to staging.

---

## 5.0 Linux: Docker group (one time)

Engine can be installed while your user still cannot talk to it:

```bash
sudo usermod -aG docker "$USER"
newgrp docker
docker run --rm hello-world
```

You already have **Go 1.22** for local CLI builds. The image **rebuilds the CLI inside Docker** so customers do not need Go.

---

## 5.1 Agent image (this week)

Named build context `cli-src` = sibling `revenant-cli` (Go module).

```bash
cd revenant-agent
chmod +x scripts/build-agent-image.sh
./scripts/build-agent-image.sh
```

Equivalent:

```bash
docker build \
  --build-context cli-src=../revenant-cli \
  --build-arg REVENANT_API_URL=http://127.0.0.1:8080 \
  -t revenant-agent:local \
  .
```

### Test CLI in the image

```bash
docker run --rm --entrypoint revenant revenant-agent:local --help
```

### Test agent against local API

API must be listening on the host (`:8080`). Token from **Settings → Services**.

```bash
docker run --rm \
  --add-host=host.docker.internal:host-gateway \
  -e REVENANT_API_URL=http://host.docker.internal:8080 \
  -e REVENANT_RUNNER_TOKEN=rvn_YOUR_TOKEN \
  revenant-agent:local
```

Expect: `whoami` OK, `cli=/usr/local/bin/revenant`, poll started. Then run a workflow in the UI.

Compose:

```bash
export REVENANT_RUNNER_TOKEN=rvn_YOUR_TOKEN
docker compose up --build
```

### Push (only after that smoke)

```bash
docker login
docker tag revenant-agent:local 277pawan/revenant-agent:0.1.0
docker push 277pawan/revenant-agent:0.1.0
docker push 277pawan/revenant-agent:latest
```

### Customer run (production API URL)

API is baked at publish. Customers only pass a token:

```bash
docker run -d --restart unless-stopped \
  -e REVENANT_RUNNER_TOKEN=rvn_xxx \
  277pawan/revenant-agent:latest
```

To change the API later: `REVENANT_API_URL=https://new.api ./scripts/publish-agent-image.sh ...` and push. Same tokens.

**Checklist**

- [ ] User in `docker` group
- [ ] `./scripts/build-agent-image.sh` succeeds
- [ ] `revenant --help` inside the image
- [ ] whoami + claim/complete against **local** API
- [ ] One workflow PASS with evidence
- [ ] Push to Docker Hub
- [ ] Update Services UI snippet with real image name

---

## 5.2 Control plane staging (next, not this hour)

| Component | Suggested target | Notes |
|-----------|------------------|-------|
| Postgres | RDS / Neon / self-hosted | Run `npm run db:migrate` |
| API | Fly.io / ECS / Railway | `DATABASE_URL`, `JWT_SECRET`, `MASTER_KEY` |
| Web | Static CDN or same host | `VITE_API_URL` at build time |
| TLS | Required | CORS origin = web URL |

**Checklist**

- [ ] Staging API + DB migrated through `0011`
- [ ] Web build points at staging API
- [ ] Smoke: login → workflow → Docker agent completes
- [ ] `ALLOW_OPEN_REGISTRATION=false` or invite-only

---

## 5.3 Production hardening (before GA)

- Rate limiting on auth + runner claim
- Backup control-plane Postgres
- Monitoring (health, job failure rate, agent last_seen)
- Token rotation after deploy
