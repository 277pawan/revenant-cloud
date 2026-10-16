/**
 * Redis artifact TTL sweeper.
 *
 * This loop is the reason a stored Redis snapshot cannot outlive its TTL. It
 * runs alongside the schedule poller and hard-deletes bytes past `expires_at`.
 *
 * It is deliberately simple — no leader election, no distributed lock. Running
 * it on every API instance is safe and intended:
 *   - deleting a missing key is a no-op,
 *   - the row update is guarded by `deleted_at IS NULL`,
 * so a second sweeper simply finds nothing to do. That property is more
 * valuable here than avoiding a redundant loop iteration.
 */
import type { Database } from "../db/index.js";
import {
  reclaimStaleRedisProofs,
  sweepExpiredRedisSnapshots,
} from "../services/redis-snapshots.service.js";

export interface RedisSweeperOptions {
  db: Database;
  intervalMs?: number;
  label?: string;
}

/** How often the TTL sweep runs. 5 minutes is well inside every plan's TTL. */
export const REDIS_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export function startRedisSnapshotSweep({
  db,
  intervalMs = REDIS_SWEEP_INTERVAL_MS,
  label = "embedded",
}: RedisSweeperOptions): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const tick = async () => {
    if (stopped) return;
    try {
      const result = await sweepExpiredRedisSnapshots(db);
      if (result.deleted > 0 || result.errors.length > 0) {
        console.log(
          `[redis-sweeper:${label}] expired ${result.deleted}/${result.scanned} snapshots, ` +
            `${result.bytesReclaimed} bytes reclaimed` +
            (result.errors.length ? `, ${result.errors.length} error(s)` : "")
        );
        for (const err of result.errors) {
          console.warn(`[redis-sweeper:${label}] ${err}`);
        }
      }
    } catch (err) {
      console.error(
        `[redis-sweeper:${label}] sweep failed:`,
        err instanceof Error ? err.message : err
      );
    }

    // Reclaim abandoned proofs here, on the 5-minute cadence — NOT in the
    // agent claim path. This used to run on every claim (every 5s per agent)
    // and was a sequential scan, because it filtered on coalesce() and there
    // was no index on `status`. 0027 fixed both.
    try {
      const reclaimed = await reclaimStaleRedisProofs(db);
      if (reclaimed > 0) {
        console.log(
          `[redis-sweeper:${label}] requeued ${reclaimed} proof(s) abandoned by a dead agent`
        );
      }
    } catch (err) {
      console.error(
        `[redis-sweeper:${label}] reclaim failed:`,
        err instanceof Error ? err.message : err
      );
    } finally {
      if (!stopped) timer = setTimeout(tick, intervalMs);
    }
  };

  console.log(
    `[redis-sweeper:${label}] TTL sweep every ${Math.round(intervalMs / 1000)}s — ` +
      `stored Redis artifacts are hard-deleted at their expires_at`
  );
  void tick();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}