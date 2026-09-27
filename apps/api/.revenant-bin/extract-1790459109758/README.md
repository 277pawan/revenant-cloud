# Revenant

[![Release](https://img.shields.io/github/v/release/277pawan/revenant-cli)](https://github.com/277pawan/revenant-cli/releases)
[![License](https://img.shields.io/github/license/277pawan/revenant-cli)](LICENSE)
[![GitHub Action](https://img.shields.io/badge/action-revenant--action-blue?logo=github)](https://github.com/277pawan/revenant-action)

**Prove your database backups actually restore** — not just that they exist.

Revenant connects to PostgreSQL (local or AWS RDS), runs validation checks from `revenant.yaml`, measures recovery time, writes a report, and tears down test sandboxes.

> **Language-agnostic.** Your app can be Node, Python, Go, Rails, or anything. Revenant never reads your source code — only live database data.

| Free CLI (this repo) | [GitHub Action](https://github.com/277pawan/revenant-action) | Phase 5 (roadmap) |
|----------------------|--------------------------------------------------------------|-------------------|
| 1 DB, yaml + CLI     | Any repo, CI/CD, no install                                  | Dashboard, fleet, audit UI |

---

## Install

### Option 1 — GitHub Action (recommended for any repo)

No Go. No npm. Copy a workflow, add secrets, done.

```yaml
- uses: 277pawan/revenant-action@v1.0.3
  with:
    version: v0.1.1
    config: revenant.yaml
  env:
    DATABASE_URL: ${{ secrets.DATABASE_URL }}
```

- **Action repo:** https://github.com/277pawan/revenant-action  
- **Examples:** [`examples/workflows/local-verify.yml`](examples/workflows/local-verify.yml) · [`examples/workflows/aws-verify.yml`](examples/workflows/aws-verify.yml)  
- **Marketplace:** [List / find on GitHub Marketplace](https://github.com/marketplace?type=actions&query=revenant) (see [revenant-action/MARKETPLACE.md](https://github.com/277pawan/revenant-action/blob/main/MARKETPLACE.md))

### Option 2 — Download binary

1. Open [Releases](https://github.com/277pawan/revenant-cli/releases)
2. Pick the file for **your OS** (see table below)
3. Extract and install on your PATH so you can type `revenant` (not `./revenant`)

| Your machine | Download |
|--------------|----------|
| Linux Intel/AMD | `revenant_0.1.1_linux_amd64.tar.gz` |
| Linux ARM | `revenant_0.1.1_linux_arm64.tar.gz` |
| Mac Intel | `revenant_0.1.1_darwin_amd64.tar.gz` |
| Mac Apple Silicon | `revenant_0.1.1_darwin_arm64.tar.gz` |
| Windows | `revenant_0.1.1_windows_amd64.zip` |

Check yours: `uname -s` and `uname -m`

```bash
tar -xzf revenant_0.1.1_linux_amd64.tar.gz
chmod +x revenant

# Install globally (pick one):
sudo install -m 755 revenant /usr/local/bin/revenant   # system-wide
# OR
mkdir -p ~/bin && mv revenant ~/bin/ && echo 'export PATH="$HOME/bin:$PATH"' >> ~/.bashrc && source ~/.bashrc

revenant --help    # works from any directory — no ./
```

**Why `./revenant`?** The `./` means “run the binary in *this folder*.” Once the binary is in a folder on your `PATH` (`/usr/local/bin`, `~/bin`), you type `revenant` only.

### Option 3 — Build from source (contributors)

```bash
git clone https://github.com/277pawan/revenant-cli.git
cd revenant-cli
go build -o revenant .
```

---

## Quick start (local Postgres)

```bash
# 1. Connection string
export DATABASE_URL='postgres://user:pass@localhost:5432/mydb?sslmode=disable'

# 2. Scaffold checks from your live schema
revenant init --plan my-app --force

# 3. Run validation
revenant verify
```

Expected:

```
✓ customers table exists
✓ orders row count 3 >= 1
✓ foreign key orders -> customers intact

Restore Validation: PASS
Wrote report.json
Wrote report.md
```

---

## Commands

| Command | What it does |
|---------|----------------|
| [`revenant doctor`](#revenant-doctor) | Check config, env vars, and DB connectivity |
| [`revenant init`](#revenant-init) | Scan a live database → write starter `revenant.yaml` |
| [`revenant verify`](#revenant-verify) | Run all checks; restore AWS snapshot first if configured |
| [`revenant snapshot`](#revenant-snapshot) | Validate source DB, then create an RDS snapshot |
| [`revenant reap`](#revenant-reap) | Delete orphaned AWS sandbox instances (safety net) |
| [`revenant migrate`](#revenant-migrate) | **Demo only** — sample tables (prompts first) |

---

### `revenant doctor`

Validate setup before a real verify run.

```bash
revenant doctor [-c revenant.yaml]
```

Checks: config loads, check fields valid, `DATABASE_URL` connects, AWS env hints if `recovery:` is set.

---

### `revenant init`

Introspect `information_schema` and generate a starter config (schema, row counts, foreign keys, one golden query).

```bash
revenant init [flags]

Flags:
  -o, --output string   Write path (default: revenant.yaml)
      --plan string     Plan name in yaml (default: local-demo)
      --schema string   Postgres schema to scan (default: public)
      --force           Overwrite existing file
```

**Requires:** `DATABASE_URL`

---

### `revenant verify`

Main command. Connects to Postgres and runs checks. If `recovery.engine: aws-rds` is set in yaml, it will:

1. Find latest RDS snapshot  
2. Restore to a temporary sandbox (`db.t3.micro` on free tier)  
3. Run checks  
4. Destroy the sandbox  

```bash
revenant verify [flags]

Flags:
  -c, --config string              Config path (default: revenant.yaml)
      --plan string                Must match yaml `plan:` if set
  -o, --output string              JSON report (default: report.json)
      --markdown string            Markdown report (default: report.md)
      --keep-sandbox-on-failure    Keep AWS sandbox when checks fail (debug)
```

**Requires:** `DATABASE_URL` (local) or AWS credentials + `SANDBOX_*` vars (restore path). See [AWS setup](AWS_FREETIER_SETUP.md).

---

### `revenant snapshot`

Validate the **source** database first; only create an RDS snapshot if all checks pass.

```bash
revenant snapshot [flags]

Flags:
  -c, --config string    Config with recovery.engine: aws-rds
  -o, --output string    JSON report (default: report.json)
      --markdown string  Markdown report (default: report.md)
```

**Requires:** `DATABASE_URL` (source RDS), AWS credentials, `recovery.source_identifier` in yaml.

---

### `revenant reap`

Find Revenant-managed RDS sandboxes older than `--max-age` and delete them. Run in CI with `if: always()` after AWS verify.

```bash
revenant reap [flags]

Flags:
      --max-age string   Age threshold (default: 2h) — e.g. 30m, 4h
      --region string    AWS region (default: AWS_REGION env)
```

**Requires:** AWS credentials with RDS delete permissions.

---

### `revenant migrate`

> **Demo / learning only — not for real apps.**

Creates **only** two hardcoded tables (`customers`, `orders`) and seed rows defined in `internal/demo/` in this repo. It does **not** read your app’s models or migrations.

| Use case | What to do instead |
|----------|-------------------|
| Real project | Your app already has tables — use `revenant init` or write `revenant.yaml` by hand |
| Try Revenant with zero setup | `revenant migrate` → `revenant init` → `revenant verify` on an empty local DB |
| AWS demo | `migrate` on source RDS before first `snapshot` (see [AWS_FREETIER_SETUP.md](AWS_FREETIER_SETUP.md)) |

```bash
revenant migrate        # prompts: creates demo customers + orders tables
revenant migrate --yes  # skip prompt (scripts only)
```

**Requires:** `DATABASE_URL`

You are right that most users never need this — `revenant init` against an existing DB is the real path. Consider removing `migrate` in a future release once docs/examples use `init` only.

---

## Configuration (`revenant.yaml`)

Lives in your repo root. Defines **what** to test — not your app code.

**Full reference:** [CONFIG.md](CONFIG.md) — every field, every check type, examples, common mistakes.

### Quick summary — 7 check types

| `type` | One line | Key yaml fields |
|--------|----------|-----------------|
| `connect` | DB accepts connections | _(none)_ |
| `schema` | Tables exist | `expect_tables: [a, b]` |
| `row_count` | Row count in range | `table`, `min`, `max` (optional) |
| `foreign_key` | FK + no orphans | `table`, `references` |
| `golden_query` | Your SQL rule | `query`, `expect_min` |
| `freshness` | Data not too old | `table`, `column`, `max_age` |
| `index` | Indexes exist | `expect_indexes: [name, …]` |

```yaml
checks:
  - type: connect

  - type: schema
    expect_tables: [customers, orders]

  - type: row_count
    table: orders
    min: 1

  - type: foreign_key
    table: orders
    references: customers

  - type: golden_query
    query: "SELECT count(*) FROM orders"
    expect_min: 1

  - type: freshness
    table: orders
    column: created_at
    max_age: 24h
```

Optional AWS block — see [CONFIG.md](CONFIG.md#full-example-aws-restore--verify) and [AWS_FREETIER_SETUP.md](AWS_FREETIER_SETUP.md).

---

## GitHub Actions

### Local Postgres (weekly proof)

Copy [`examples/workflows/local-verify.yml`](examples/workflows/local-verify.yml) → `.github/workflows/`.

### AWS RDS restore (weekly proof + cleanup)

Copy [`examples/workflows/aws-verify.yml`](examples/workflows/aws-verify.yml) → `.github/workflows/`.

Secrets needed for AWS: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `SANDBOX_USER`, `SANDBOX_PASSWORD`.

### Publish the Action on Marketplace

GitHub no longer uses `marketplace/actions/new` (404). Use the **blue banner** on the action repo:

1. Open https://github.com/277pawan/revenant-action  
2. Click **Draft a release** (in the banner)  
3. Check **Publish this Action to the GitHub Marketplace**  
4. Pick category → **Publish release**  

Full steps: [revenant-action/MARKETPLACE.md](https://github.com/277pawan/revenant-action/blob/main/MARKETPLACE.md)

---

## AWS RDS workflow

Full zero-cost setup: **[AWS_FREETIER_SETUP.md](AWS_FREETIER_SETUP.md)**

Typical flow:

```bash
# Optional demo tables on source (demo command only — see migrate section)
revenant migrate

# Snapshot source (after checks pass)
revenant snapshot --config revenant-aws-freetier.yaml

# Restore latest snapshot → validate → destroy sandbox
revenant verify --config revenant-aws-freetier.yaml

# Safety net if a run crashed
revenant reap --max-age 4h --region us-east-1
```

---

## Reports

| File | Use |
|------|-----|
| `report.json` | CI parsing, automation |
| `report.md` | Human review, audit attachment |

Upload both as workflow artifacts (`actions/upload-artifact@v4`).

---

## Project layout

```
revenant-cli/
├── cmd/           # doctor, init, verify, snapshot, reap, migrate
├── internal/
│   ├── checks/    # schema, row_count, foreign_key, golden_query, freshness
│   ├── recovery/  # AWS RDS restore + reaper
│   ├── discover/  # revenant init
│   └── report/    # json + markdown
├── examples/workflows/   # copy-paste CI templates
├── revenant.yaml         # local config example
└── revenant-aws-freetier.yaml
```

---

## Roadmap

| Phase | Status | What |
|-------|--------|------|
| 1–4 | ✅ Done | CLI, checks, AWS restore, reports, Action |
| 5 | Planned | Hosted UI, scheduler, fleet, signed evidence, docs site |

Phase 5 docs and operations UI will live in the paid product — not in this repo.

---

## Contributing

```bash
go test ./...
go build -o revenant .
```

See [RELEASE.md](RELEASE.md) for maintainer release process.

---

## License

[Apache-2.0](LICENSE)

---

## Links

- **CLI releases:** https://github.com/277pawan/revenant-cli/releases  
- **GitHub Action:** https://github.com/277pawan/revenant-action  
- **Issues:** https://github.com/277pawan/revenant-cli/issues  
