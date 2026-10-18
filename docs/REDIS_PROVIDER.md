# Redis provider — design and positioning

> **One line:** Revenant proves a Redis backup *restores*. It is not a Redis backup vendor,
> and the optional snapshot storage it does keep is TTL-bounded by design.

## Why this exists

A self-hosted Redis keeps its RDB on the same disk that fails. Nobody checks whether
that file still loads. This is the same gap Revenant already closes for PostgreSQL and
RDS — it just happens to be one nobody has looked at.

The value is **proof**, not storage:

```
paste Redis URL → connect + fingerprint
                → capture a real RDB off the live server
                → boot a throwaway redis-server against that exact file
                → compare what came back against what was there
                → green or red, with signed evidence
```

## What we deliberately do NOT do

| Not doing | Why |
|---|---|
| Store Redis bytes in the control-plane Postgres | `bytea` caps at ~1 GB, a 40 GB blob would generate 40 GB of WAL, and it makes our own backups huge and slow. It also turns us into a data processor holding customer sessions. |
| Invent a compression scheme | Don't write one — use gzip/zstd. But don't assume compression is pointless either: see the measurements below. |
| Compete with RDS/ElastiCache managed backups | For AWS-managed Redis the cloud already does backup and restore. Drilling it is low value. |
| Run anything expensive against the live cache | A proof must never stall production traffic. |

**The rule:** *metadata in Postgres, bytes in the artifact store — or nowhere.*

## Compression, measured rather than assumed

An earlier draft of this document claimed that because an RDB is already
LZF-compressed (`rdbcompression yes`), re-compressing it "buys roughly 5–15%",
and defaulted to storing raw bytes. **That was wrong.** Measured on real RDBs:

| Workload | RDB size | gzip -6 | zstd -9 |
|---|---|---|---|
| 20k JSON product docs | 2,089,173 B | 274,129 B (**86.9% smaller**) | — |
| 40k mixed cache keys | 2,900,435 B | 788,756 B (**72.8% smaller**) | 716,642 B (**75.3% smaller**) |

gunzip runs at **~322 MB/s** on a single core, so decompression is not a
meaningful part of restore time.

The error was assuming LZF's ratio approximates a modern codec's. LZF trades
ratio for BGSAVE speed and leaves a great deal behind — and real cache payloads
are JSON-shaped with repeated key structure, which is close to the best case for
DEFLATE. **gzip is the default**; `zstd` is available on Node ≥ 22.15.

The chosen encoding is recorded per artifact in `redis_snapshots.compression`,
so changing the setting later can never break restoring an older snapshot.

## Storage backend: pick R2 or B2, not S3

When you move off local disk, use **Cloudflare R2 or Backblaze B2**.

Every proof pulls the artifact back down, so egress — not storage — is the bill that
matters. Storage is ~$0.015/GB-month (noise). S3 and GCS charge per-GB egress, which on a
restore-heavy product scales with *success*. R2 and B2 charge **$0 egress**, and both have
free tiers (10 GB), so the migration can happen without a budget conversation.

The switch is a config value, not a rewrite, because everything goes through
`ArtifactStore` (`src/lib/artifact-store.ts`).

## TTL is the feature, not a setting

Every stored artifact gets `expires_at` the moment it is created, and three independent
guards enforce it:

1. `redis_snapshots.expires_at` is `NOT NULL` — no deadline, no row.
2. A partial index makes the sweep cheap; the sweeper runs every 5 minutes.
3. A `CHECK` constraint on `redis_resources` refuses an enabled resource with no positive
   retention window.

`resolveRedisSnapshotRetentionHours()` **clamps down** to the plan ceiling. A customer
asking for a year on Starter gets 24 hours. There is no code path that produces an
unbounded artifact, because an unbounded snapshot in our bucket is an unbounded bill *and*
an unbounded data-protection obligation.

## Plan ladder

| Plan | Redis instances | Restore proofs / month | Snapshot TTL | Stores artifacts |
|---|---|---|---|---|
| Developer (free) | 0 (CLI only) | unlimited, local | — | no |
| Starter ₹499 | 1 | 4 | 24 h | yes |
| Pro ₹1,499 | 10 | 30 | 7 days | yes |
| Enterprise | fair use | fair use | custom | yes |

The free path is `revenant redis-prove` on the customer's own machine: no account, no
agent, no cloud. Paid tiers sell *central retention and repeated proof*, never bytes.

The local CLI proof is intentionally narrower than this managed provider: it accepts
only a loopback source endpoint and requires the configured absolute RDB path to be
readable on the CLI host. A forwarded container port is not sufficient unless the
source RDB directory is mounted at that same host path. Remote and managed Redis
RDB transfer is not implemented by the CLI; managed proofs use the separate runner
workflow below. The CLI compares a bounded sample of the same keys, not the entire
keyspace, and does not infer historical RPO from its proof-triggered `BGSAVE`.

## Architecture

| Layer | File | Role |
|---|---|---|
| Contract | `packages/shared/src/redis.ts` | Types, check names, URL parsing, redaction |
| Plan limits | `packages/shared/src/plans.ts` | TTL clamp, quota, tier values |
| Control plane | `apps/api/src/db/schema.ts` | `redis_resources`, `redis_credentials`, `redis_snapshots`, `redis_proofs` |
| Connection | `apps/api/src/lib/redis-client.ts` | Dependency-free RESP client + fingerprint |
| Storage | `apps/api/src/lib/artifact-store.ts` | `ArtifactStore` interface, local-disk impl |
| Services | `apps/api/src/services/redis-*.service.ts` | CRUD, proofs, quota, claim/complete, sweeper |
| Sweeper | `apps/api/src/scheduler/redis-snapshot-sweep.ts` | 5-minute TTL enforcement loop |
| User API | `apps/api/src/routes/v1/redis.routes.ts` | `/api/v1/redis/*` |
| Runner API | `apps/api/src/routes/v1/runner-redis.routes.ts` | `/api/v1/runner/redis-proofs/*` |
| Dashboard | `revenant-cloud-web/src/pages/RedisPage.tsx` | Add, test, run proof, inspect snapshots |
| CLI (free) | `revenant-cli/internal/redis/`, `cmd/redis_prove.go` | `redis-prove` — no Docker needed |
| Agent (Docker) | `revenant-agent/src/redis-sandbox.ts`, `redis-proof-poll.ts` | Throwaway `redis-server` in a container |

### Why the agent uses `redis-cli --rdb`

Rather than reading the RDB off disk, `redis-cli --rdb <file>` asks the **server** to
stream a complete dump over the wire. That means:

- no filesystem access to the customer's Redis (it may be in a container or a volume),
- no `redis-cli` installed on the customer's box — it runs inside our image,
- no dependency on the `dir`/`dbfilename` config being readable.

The sandbox then runs with `--save "" --appendonly no`, so it persists nothing and cannot
write back into the customer's dump.

## What we never store

| Data | Stored? |
|---|---|
| Keyspace counts, TTL histogram | yes |
| `maxmemory-policy`, `appendonly`, `save` | yes |
| `requirepass` | **only whether it is set** — never the value |
| Sampled keys/values | **SHA-256 digests only** |
| RDB bytes | only if the customer opts in, always with a TTL |

Digests are computed server-side with `redis.sha1hex` and hashed again on the host, so no
raw key or value ever crosses into Revenant's memory or database.

## Related

- Manual test script: [REDIS_MANUAL_TEST.md](./REDIS_MANUAL_TEST.md)
- Provider roadmap: [REVENANT_STATUS_AND_ROADMAP.md](./REVENANT_STATUS_AND_ROADMAP.md)