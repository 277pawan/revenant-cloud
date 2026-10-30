# Redis provider — system design & query budget

> Written after a review found the claim loop issuing **6 queries every 5 seconds
> per agent, with a sequential table scan while completely idle**. This document
> is the call budget and the rules for keeping it that way.

---

## Who runs a Redis proof (and why there used to be only one answer)

**This is the answer to "who decided an online Redis proof worker was
required?" — nobody, deliberately. It was an accident of the first design.**

The original Redis provider shipped with exactly ONE executor: a self-hosted
`revenant-agent`. The reasoning was "a restore proof needs a throwaway
redis-server, and the cloud API has no runtime to run one in". So the agent
owned the sandbox (`revenant-agent/src/redis-sandbox.ts`) and the proof queue
had exactly one consumer.

The consequence was that a dashboard button had a hidden prerequisite: an
always-on service the customer had to deploy and operate. In any deployment
without one, every proof sat in `pending` until the sweeper failed it 30
minutes later with *"No Redis proof worker claimed this run"* — a message that
named a component the customer had never heard of.

**The premise was wrong.** The API already reaches the customer's Redis
directly (the URL probe proves it), so the same box can host the sandbox. The
proof now runs **inside the API process**, as a throwaway `redis-server` on
loopback — the same thing the `revenant redis-prove` CLI does on a customer's
laptop, with no Docker daemon and no second deployment.

### One queue, two consumers

| Consumer | Where it runs | Claims when |
|---|---|---|
| **Cloud worker** (`apps/api/src/scheduler/redis-proof-worker.ts`) | inside the API | the Redis is reachable from the cloud |
| **Agent** (`revenant-agent`) | customer's network | always — it may reach what the cloud cannot |

Both claim the same row with `FOR UPDATE … SKIP LOCKED`, so N executors across
N API instances and N agents share one queue without coordination.

When the cloud worker cannot reach a Redis it does **not** fail the proof —
that would be a lie, because the backup was never tested. It releases the run
(`status='pending'`, `last_error_kind='unreachable'`) and leaves it for an
agent inside the customer's network. The dashboard then says *why* it is
waiting instead of spinning.

### The proof state machine

```
        ┌───────────── claim ─────────────┐
        │                                   ▼
   ┌─────────┐   release (unreachable)   ┌─────────┐
   │ pending │ ─────────────────────────►│ running │
   └─────────┘◄───────────────────────── └─────────┘
        │                                   │
        │ queue timeout                    ├─ pass   → verified
        │ (30 min)                         ├─ fail   → the backup is bad
        ▼                                   └─ error  → the check could not run
     ┌────────┐
     │ error  │
     └────────┘
```

Three terminal states, because they mean three different things to a customer:

- **pass** — the backup restored.
- **fail** — the backup was tested and did not come back.
- **error** — the check could not be run (no sandbox, version skew, refused
  credentials). Reporting a failed CHECK as a failed BACKUP sends the
  customer hunting for a problem they do not have.

### Capture strategies

| Strategy | When | What it proves |
|---|---|---|
| `rdb` | the server will stream its RDB (`SYNC`/`REPLCONF` allowed) | the actual backup FILE restores |
| `logical` | the provider refuses to hand out its RDB | the DATA comes back intact |

Azure Cache for Redis answers `ERR command 'replconf' is not allowed`, so the
RDB path cannot run there. The logical path uses only commands every Redis
allows — `SCAN`, `DUMP`, `PTTL`, `RESTORE` — and compares a **content digest**
of the source against a content digest of the restored instance. (Not the
`DUMP` payload: that embeds an absolute expiry timestamp, so it differs on
every read and would fail for every key with a TTL.)

### Version matching

A Redis server can read an OLDER data format but never a newer one. A Redis 7
sandbox handed a Redis 8 payload fails with *"DUMP payload version or
checksum are wrong"* — which reads exactly like a corrupt backup and is not
one. So the sandbox binary is chosen at run time: the first candidate that
exists AND is at least as new as the customer's Redis. The image ships Redis 8
as `redis-server-8` (see the `Dockerfile`).

---

## The blunder, honestly

The first cut of `claimNextRedisProof` looked reasonable and was not:

| # | Query | Problem |
|---|---|---|
| 1 | `UPDATE … reclaim stale` | `WHERE status='running' AND coalesce(started_at, created_at) < X` |
| 2 | `SELECT oldest pending` | `WHERE status='pending'` |
| 3 | `UPDATE claim` | race-prone select-then-update |
| 4 | `SELECT resource` | separate round trip |
| 5 | `SELECT credential` | separate round trip |
| 6 | `SELECT snapshot` | separate round trip |

Two independent index problems in query #1:

1. **No index on `status`.** The only indexes were
   `(organization_id, created_at)` and `(redis_resource_id, created_at)` —
   neither is usable for `WHERE status = 'running'`.
2. **`coalesce()` is not an indexable expression in Postgres.** Even with an
   index, the planner could never use it.

So an agent with **zero Redis work to do** ran a sequential scan of
`redis_proofs` every 5 seconds — **17,280 scans per agent per day** — and six
round trips besides. Ten idle agents is 172,800 scans/day for a feature nobody
was using.

The query #3 race was a correctness bug too: two agents could both read the same
`pending` proof, one would win the UPDATE, and the other would silently throw
away a proof it had already started (or worse, complete one twice).

---

## The fix

### 1. Partial indexes sized for the two states the loop touches — `0027`

```sql
CREATE INDEX redis_proofs_pending_idx  ON redis_proofs (created_at) WHERE status = 'pending';
CREATE INDEX redis_proofs_running_idx  ON redis_proofs (started_at)  WHERE status = 'running';
CREATE INDEX redis_proofs_join_idx     ON redis_proofs (redis_resource_id, snapshot_id) WHERE status = 'pending';
```

Partial indexes are **bounded by in-flight work, not by history**. An org with
10,000 historical proofs still has a 0-row `pending` index, so the idle claim is
an index-only scan of an empty b-tree.

### 2. One query instead of four — `claimNextRedisProof`

A single `SELECT … JOIN … FOR UPDATE OF redis_proofs SKIP LOCKED LIMIT 1` pulls
the proof, resource, credential and snapshot together, then one `UPDATE` marks it
running. **6 queries → 2.**

`SKIP LOCKED` is the correct Postgres work-queue primitive: concurrent agents
never block on each other and never claim the same row. This also fixes the race
above.

### 3. Reclaim moved off the hot path

`reclaimStaleRedisProofs` now filters on `started_at` directly — indexable —
and runs from the **5-minute sweeper**, not from the 5-second claim endpoint.

### 4. Idle backoff in the agent

`startRedisProofPoll` doubles its interval on each empty poll
(5s → 10s → 20s → 40s → **60s cap**) and resets the moment real work arrives.
An idle agent now asks **once a minute, not 17,280 times a day**.

### 5. Frontend stopped guessing

`proofsUsedThisMonth` was being computed **client-side by summing a
`LIMIT 50` proof list** — silently undercounting any customer past 50 runs. It is
now a server-side count (`redis_proofs_month_count_idx`) returned with the
overview. The dashboard header reads `2/4 proofs this month`, not just `4/month`.

The dashboard also **only polls while a proof is actually in flight and the tab
is visible**. A fixed interval would mean a permanent request stream from every
open tab, on top of the agent already polling server-side.

---

## Query budget

### Per HTTP request

| Endpoint | Queries | Notes |
|---|---|---|
| `GET /api/v1/redis` | 1 | single indexed select |
| `POST /api/v1/redis/test` | **0** | connects to Redis, writes nothing |
| `POST /api/v1/redis` | 4 | name dup check, DB link check, insert resource, upsert credential |
| `GET /api/v1/redis/:id/proofs` | 3 | proofs + snapshots + quota, in parallel |
| `POST /api/v1/redis/:id/proofs` | 3 | plan lookup, quota count, insert proof (+snapshot if storing) |
| `DELETE /api/v1/redis/:id` | 2 + N | list storage keys, purge bytes, then delete (cascades) |

### Per executor poll

| State | Queries | Cadence |
|---|---|---|
| Idle | **2** (both index-only) | 5s → 60s backoff |
| Busy | 2 + 2 | per proof |

### Background loops (per API instance)

| Loop | Queries | Cadence |
|---|---|---|
| Redis TTL sweep | 1 indexed select + N deletes | 5 min, batch 200 |
| Redis reclaim | 1 indexed update | 5 min |
| Redis proof worker | 2 index-only + 1 in-flight count | 5s → 60s backoff |

The in-flight count is a `COUNT` over `redis_proofs_running_idx` — a partial
index bounded by running work, not by history. It caps how many proofs the
fleet runs at once, because every running proof holds a throwaway
redis-server with its own memory ceiling.

---

## Rules to keep it this way

1. **Never `coalesce()` a column in a hot-path predicate.** Write the query so
   it can use an index, or accept a sequential scan knowingly.
2. **New filter columns need an index.** `status` had two indexes that were
   both useless for the only query that filtered on it.
3. **Never select-then-update a queue.** `FOR UPDATE … SKIP LOCKED` or nothing.
4. **Background work belongs on the slow loop, not the fast one.** Reclaim is
   5 minutes of staleness tolerance, so it does not belong on a 5-second path.
5. **Count in the database.** Any quota or usage number must be a server-side
   `COUNT`, never the client summing a paginated list.
6. **Poll only when there is something to poll for**, and stop when the tab is
   hidden.

---

## Verifying the fix yourself

```sql
-- Claim is now index-only. Before: Seq Scan on redis_proofs.
EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM redis_proofs WHERE status = 'pending' ORDER BY created_at LIMIT 1;

-- Reclaim uses started_at, not coalesce() — should show an Index Scan.
EXPLAIN (ANALYZE, BUFFERS)
SELECT id FROM redis_proofs
WHERE status = 'running' AND started_at < now() - interval '30 minutes';
```

**PASS:** both report `Index Scan` / `Index Only Scan` on the partial indexes,
not `Seq Scan on redis_proofs`.

Watch it settle:

```bash
# with the agent idle, count statements hitting the DB over a minute
psql "$DATABASE_URL" -c "
  SELECT calls, query
  FROM pg_stat_statements
  WHERE query LIKE '%redis_proofs%'
  ORDER BY calls DESC LIMIT 5;"
```

**PASS:** steady-state calls settle to roughly **1/minute per agent**, not
288.

## Known remaining cost

`GET /api/v1/redis/:id/proofs` returns up to 50 proofs **and** 100 snapshots
unbounded by size — only row-bounded. If snapshot counts grow, paginate the
snapshots list. Proofs are capped deliberately because they are the audit trail;
snapshots are capped because they are operational history that the TTL bounds
anyway.