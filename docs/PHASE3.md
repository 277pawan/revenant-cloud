# Phase 3 — AWS snapshot restore via control plane

**Status:** complete (core path)  
**Prerequisite:** Phase 2.5 (agent + workflows), CLI `revenant verify` with `recovery.engine: aws-rds`

## Goal

Run the same DR drill as GitHub Actions (`free-restore-test.yml`) from the dashboard:

1. Agent claims job
2. `revenant verify` finds latest RDS snapshot
3. Restores to temporary sandbox
4. Runs validation plan checks
5. Tears down sandbox
6. Report → evidence vault + webhooks

## What was built

### 3.1 Database recovery mode + encrypted AWS keys

- `databases.recovery_mode`: `direct` | `aws-rds`
- `databases.rds_source_identifier`, `recovery_use_freetier`, `recovery_sandbox_instance_class`
- `database_aws_credentials` — AES-256-GCM encrypted JSON `{ accessKeyId, secretAccessKey }`
- Migration: `0010_phase3_aws_recovery.sql`

### 3.2 Claim payload + agent execution

Runner claim returns (runner-only, never in public APIs):

- `recovery` — RDS instance ID, region, sandbox options
- `awsCredentials` — decrypted access keys for `AWS_*` env vars
- `password` — RDS master password → `SANDBOX_PASSWORD`

`execute-job` builds CLI yaml with `recovery:` block and runs verify with 35 min timeout.

### 3.3 UI

- Database wizard / edit: **Direct** vs **AWS RDS snapshot restore**
- AWS fields: instance ID, region, master user/pass/db, IAM keys, free tier toggle

## How to test locally

```bash
# 1. Migrate
cd revenant-cloud/apps/api && npm run db:migrate

# 2. Rebuild shared types
cd revenant-cloud/packages/shared && npm run build

# 3. Create database in UI with mode "AWS RDS snapshot restore"
#    Use same values as revenant-aws-freetier.yaml / your free tier RDS

# 4. Save validation plan (checks from freetier yaml)

# 5. Issue agent token (Services page) and run agent with CLI on PATH:
export REVENANT_RUNNER_TOKEN=rvn_xxx
export REVENANT_CLI_PATH=/path/to/revenant-cli/revenant
cd revenant-agent && npm run dev

# 6. Trigger job from Workflows → Run
```

## Environment

| Variable | Default | Purpose |
|----------|---------|---------|
| `REVENANT_AWS_VERIFY_TIMEOUT_MS` | `2100000` (35 min) | AWS restore + verify timeout |
| `REVENANT_VERIFY_TIMEOUT_MS` | `120000` | Direct Postgres verify timeout |

## Not in this phase (later)

- [ ] `revenant snapshot` from cloud (pre-verify backup step)
- [ ] KMS / `MASTER_KEY` rotation
- [ ] `revenant reap` scheduled from cloud
- [ ] Workflow graph snapshot/restore nodes

## Phase 5 reminder

Docker Hub + staging deploy remain on hold until you're ready — local agent + `npm run dev` is enough for Phase 3 testing.
