# Runners — how jobs actually run

Revenant Cloud API is a **control plane**. A worker must claim jobs.

## What you run day-to-day

```bash
cd revenant-cloud && npm run db:migrate && npm run dev
```

That is enough for local use. **`EMBEDDED_RUNNER=auto`** (default in development) starts a worker **inside the API process**. Create a job in the UI → it is claimed and completed automatically. No second terminal.

Optional: set `REVENANT_CLI_PATH` to your `revenant` binary (or keep the sibling `../revenant-cli/revenant`). When found, jobs run real `revenant verify`. If missing, checks fall back to metadata-only (labeled simulated).

## When do you need `runner:agent`?

| Audience | What they run |
|----------|----------------|
| **You, local SaaS demo** | Just `npm run dev` (embedded worker) |
| **Customer / self-hosted** | Install agent on their box with org token from Settings → Runners |
| **CI** | GitHub Action with org token (`kind: ci`) |
| **Future paid cloud** | Managed workers — same claim/complete API |

End users of a hosted product do **not** run `npm run runner:agent` every time. That script is for **self-hosted / customer machines**, not for clicking “Run” in the cloud UI.

Standalone scripts (still useful for debugging):

```bash
npm run runner:stub    # same as embedded, separate process
npm run runner:agent   # org-scoped token
```

## Labels

| `executionMode` | Meaning |
|-----------------|--------|
| `stub` | Embedded / stub token path without real CLI (or forced simulate) |
| `agent` | Org agent token, or embedded path that ran `revenant verify` |
| `ci` | Org token with `kind: ci` |

## Env

| Variable | Purpose |
|----------|---------|
| `EMBEDDED_RUNNER` | `auto` / `true` / `false` — auto = on unless `NODE_ENV=production` |
| `RUNNER_TOKEN` | Stub + embedded worker auth |
| `REVENANT_CLI_PATH` | Absolute path to `revenant` binary |
| `REVENANT_FORCE_SIMULATE` | `true` → never call CLI |
| `REVENANT_STUB_SIMULATE` | `true` → stub/embedded skip CLI |

## Scaling later

Keep `POST /runner/claim` + `POST /runner/jobs/:id/complete`. Swap embedded/agent for ECS workers without changing the product contract.
