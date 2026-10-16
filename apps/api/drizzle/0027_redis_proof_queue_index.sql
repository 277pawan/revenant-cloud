-- Redis proof queue: make the agent claim loop cheap.
--
-- THE PROBLEM THIS FIXES
--
-- The claim endpoint was polled every 5s per agent and issued:
--   1. UPDATE ... reclaim stale   ← WHERE status='running' AND coalesce(started_at, created_at) < X
--   2. SELECT oldest pending
--   3. UPDATE claim
--   4. SELECT resource
--   5. SELECT credential
--   6. SELECT snapshot
--
-- Six queries per tick, and #1 could not use an index for two independent
-- reasons: there was no index on `status`, and `coalesce()` is not an
-- indexable expression in Postgres. So an IDLE agent full-scanned
-- redis_proofs every 5 seconds — 17,280 seq scans per agent per day.
--
-- THE FIX
--
--   • Partial indexes sized for the two states the loop actually touches.
--     A claim when idle becomes an index-only scan of a near-empty index.
--   • Reclaim no longer uses coalesce(), so it CAN use its index.
--
-- Both partial indexes are tiny: they only contain rows currently pending or
-- currently running, which is bounded by the number of agents, not by history.

-- Claim path: WHERE status = 'pending' ORDER BY created_at LIMIT 1
-- Index-only scan when idle. This is the hot path.
CREATE INDEX IF NOT EXISTS "redis_proofs_pending_idx"
  ON "redis_proofs" ("created_at")
  WHERE "status" = 'pending';

-- Reclaim path: WHERE status = 'running' AND started_at < X
-- Rewritten to avoid coalesce() so this stays indexable.
CREATE INDEX IF NOT EXISTS "redis_proofs_running_idx"
  ON "redis_proofs" ("started_at")
  WHERE "status" = 'running';

-- Claim path also joins out to the resource. Covering the join key keeps the
-- claim from touching redis_resources' heap for the payload fetch.
CREATE INDEX IF NOT EXISTS "redis_proofs_join_idx"
  ON "redis_proofs" ("redis_resource_id", "snapshot_id")
  WHERE "status" = 'pending';

-- Sweeper path already had redis_snapshots_sweep_idx, but a proof-history list
-- filtered by org+resource needs the reverse of redis_proofs_resource_idx for
-- the quota count, which scans the whole month.
CREATE INDEX IF NOT EXISTS "redis_proofs_month_count_idx"
  ON "redis_proofs" ("organization_id", "created_at")
  WHERE "status" IS NOT NULL;