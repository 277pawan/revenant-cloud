# revenant.yaml reference

Everything you can put in `revenant.yaml`. Revenant reads this file only — not your application source code.

Use `revenant init` to auto-generate a starter file from a live database, then edit checks by hand.

---

## Top-level fields

```yaml
plan: my-app-name          # required — label for reports

database:
  engine: postgres         # required — only "postgres" today
  connection: ${DATABASE_URL}   # required — use ${VAR} for secrets

recovery:                  # optional — AWS snapshot restore before verify
  engine: aws-rds
  source_identifier: my-rds-instance-id
  region: us-east-1
  use_freetier: true       # db.t3.micro (free tier)
  sandbox_instance_class: db.t4g.micro   # optional override
  max_sandbox_age: 2h      # hint for reaper

checks:                    # required — at least one check
  - type: schema
    # ...
```

### Environment variables in yaml

Any `${VAR_NAME}` in `database.connection` is read from the shell or `.env`.

| Variable | When needed |
|----------|-------------|
| `DATABASE_URL` | Local verify, `init`, `snapshot` (source DB) |
| `SANDBOX_USER` | AWS restore — master user on restored instance |
| `SANDBOX_PASSWORD` | AWS restore |
| `SANDBOX_DBNAME` | AWS restore — database name inside snapshot |
| `SANDBOX_ENDPOINT` | Filled automatically after restore (do not set manually) |
| `AWS_ACCESS_KEY_ID` | AWS commands |
| `AWS_SECRET_ACCESS_KEY` | AWS commands |
| `AWS_REGION` | AWS commands (or set `recovery.region`) |

---

## Check types (all supported today)

### `connect` — database reachable

```yaml
- type: connect
```

| Field | Required | Description |
|-------|----------|-------------|
| _(none)_ | | Pings Postgres before heavier checks |

---

### `schema` — tables exist

```yaml
- type: schema
  expect_tables:
    - customers
    - orders
    - invoices
```

| Field | Required | Description |
|-------|----------|-------------|
| `expect_tables` | yes | List of table names in `public` schema |

One result per table (PASS if exists, FAIL if missing).

---

### `row_count` — row count range

```yaml
- type: row_count
  table: orders
  min: 100
  max: 500000   # optional — fail if restore exploded
```

| Field | Required | Description |
|-------|----------|-------------|
| `table` | yes | Table name |
| `min` | yes | Row count must be `>= min` |
| `max` | no | Row count must be `<= max` |

---

### `index` — indexes exist

```yaml
- type: index
  expect_indexes:
    - orders_pkey
    - idx_orders_customer_id
```

| Field | Required | Description |
|-------|----------|-------------|
| `expect_indexes` | yes | Index names in `public` schema |

---

### `foreign_key` — relationship intact

```yaml
- type: foreign_key
  table: orders          # child table
  references: customers  # parent table
```

| Field | Required | Description |
|-------|----------|-------------|
| `table` | yes | Child table (has the FK column) |
| `references` | yes | Parent table |

Checks:
1. Postgres has a single-column FK from child → parent
2. No orphan rows (child FK value with no matching parent)

Composite (multi-column) FKs are not supported yet.

---

### `golden_query` — your business rule

```yaml
- type: golden_query
  query: "SELECT count(*) FROM orders WHERE created_at > NOW() - INTERVAL '7 days'"
  expect_min: 1
```

| Field | Required | Description |
|-------|----------|-------------|
| `query` | yes | Single SQL statement; first column of first row is the number |
| `expect_min` | yes | That number must be `>= expect_min` |

Use this for rules only you know — refunds, active users, recent orders, etc.

---

### `freshness` — data not too old (RPO)

```yaml
- type: freshness
  table: orders
  column: created_at
  max_age: 24h
```

| Field | Required | Description |
|-------|----------|-------------|
| `table` | yes | Table name |
| `column` | yes | Timestamp column (`created_at`, `updated_at`, …) |
| `max_age` | yes | Duration: `30m`, `24h`, `7d` (Go duration format) |

Finds the **latest** value in `column`; fails if older than `max_age`.

---

## Full example (local)

```yaml
plan: production-smoke

database:
  engine: postgres
  connection: ${DATABASE_URL}

checks:
  - type: connect
  - type: schema
    expect_tables: [users, orders, payments]

  - type: row_count
    table: orders
    min: 1

  - type: foreign_key
    table: orders
    references: users

  - type: golden_query
    query: "SELECT count(*) FROM orders WHERE status = 'paid'"
    expect_min: 1

  - type: freshness
    table: orders
    column: created_at
    max_age: 48h
```

---

## Full example (AWS restore + verify)

```yaml
plan: aws-weekly-restore

database:
  engine: postgres
  connection: postgres://${SANDBOX_USER}:${SANDBOX_PASSWORD}@${SANDBOX_ENDPOINT}:5432/${SANDBOX_DBNAME}?sslmode=require

recovery:
  engine: aws-rds
  source_identifier: prod-database-1
  region: us-east-1
  use_freetier: true
  max_sandbox_age: 2h

checks:
  - type: schema
    expect_tables: [customers, orders]
  - type: row_count
    table: orders
    min: 1
```

---

## Checks we should add (honest priority)

What you have today covers a **smoke test** after restore. What auditors and SREs actually ask for is broader.

| Priority | Check | Why it matters |
|----------|-------|----------------|
| **High** | `connect` / ping | Prove you can authenticate — before any SQL |
| **High** | `not_empty` on critical tables | `row_count min:1` works but a named “critical tables” check is clearer |
| **High** | `checksum` / row count **range** | `min` only — no “table exploded to 10× normal” detection |
| **Medium** | `index` | Restored DB missing indexes = slow or broken app |
| **Medium** | `column` / types | Schema drift after restore |
| **Low** | `constraint` by name | FK check partly covers this |
| **Low** | `max_row_count` | Nice for anomaly detection |

The “planned” list in earlier docs (`index`, `column`, …) was aspirational — **not** committed work. Ship **checksum/range** and **connect** before more catalog introspection.

---

## Planned checks (not built — do not promise these yet)

| Type | Status |
|------|--------|
| `index` | Idea only |
| `column` | Idea only |
| `constraint` | Idea only |
| `max_row_count` | Idea only |

Track real demand in GitHub issues before building.

---

## Common mistakes

| Problem | Fix |
|---------|-----|
| `expect_tables` ignored | Wrong yaml indent — must be under the `- type: schema` item |
| `row_count` ignored | Used `expect_tables` on a `row_count` check — use `table` + `min` |
| `unknown type` | Typo: use `row_count` not `rowcount` |
| Connection empty | Export `DATABASE_URL` or use `.env` |
| AWS verify fails early | Set `SANDBOX_*` secrets; `SANDBOX_ENDPOINT` is auto-filled after restore |
