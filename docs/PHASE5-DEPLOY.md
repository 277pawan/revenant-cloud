# Phase 5 — Deploy & Docker Hub agent

**Status:** Agent image downloads the latest published CLI release at runtime.
**Prerequisite:** Agent tested locally against cloud API (Phase 2.5)

## Goal

The agent image contains no CLI binary. At startup the runner downloads the latest
published `revenant-cli` GitHub release; private repositories require a
read-only `REVENANT_CLI_GITHUB_TOKEN` supplied at runtime.

---

## 5.0 Linux: Docker group (one time)

Engine can be installed while your user still cannot talk to it:

```bash
sudo usermod -aG docker "$USER"
newgrp docker
docker run --rm hello-world
```

---

## 5.1 Agent image

```bash
cd revenant-agent
chmod +x scripts/build-agent-image.sh
./scripts/build-agent-image.sh
```

Equivalent:

```bash
docker build \
  --build-arg REVENANT_API_URL=http://127.0.0.1:8080 \
  -t revenant-agent:local \
  .
```

### Test agent against local API

API must be listening on the host (`:8080`). Token from **Settings → Services**.
Set `REVENANT_CLI_GITHUB_TOKEN` in the environment for access to the private
release repository.

```bash
docker run --rm \
  --add-host=host.docker.internal:host-gateway \
  -e REVENANT_API_URL=http://host.docker.internal:8080 \
  -e REVENANT_RUNNER_TOKEN=rvn_YOUR_TOKEN \
  -e REVENANT_CLI_GITHUB_TOKEN \
  revenant-agent:local
```

Expect: `whoami` OK, latest release resolved, poll started. Then run a workflow in the UI.

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
