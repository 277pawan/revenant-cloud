/**
 * Managed Redis proof worker — Revenant's own executor.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS REPLACES
 *
 * Redis restore proofs used to have exactly one executor: a self-hosted
 * Revenant agent. That made "a second always-on service you must deploy and
 * operate" a hidden prerequisite of a button in the dashboard, and every
 * proof in a deployment without one sat in `pending` until the sweeper
 * failed it with "No Redis proof worker claimed this run".
 *
 * This worker is that executor, running inside the cloud API — the same
 * "managed cloud runner" model the product already uses for Postgres drills
 * (EMBEDDED_RUNNER). No Docker, no customer-operated process, no extra
 * deployment.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ONE QUEUE, TWO CONSUMERS
 *
 * The proof queue is shared. Revenant's cloud worker claims a proof when it
 * can reach the customer's Redis; a self-hosted agent claims it when the
 * Redis lives inside a private network the cloud cannot route to. Both use
 * the same `FOR UPDATE ... SKIP LOCKED` claim, so N executors across N API
 * instances never collide and never block each other.
 *
 * When the cloud worker fails to reach a Redis it does NOT fail the proof —
 * that would be a lie, because the backup was never tested. It hands the run
 * back to the queue and lets an agent inside the customer's network take it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SCALING
 *
 *   - Horizontal: every API instance runs this loop. The claim is a
 *     SKIP LOCKED row lock, so instances share the queue safely.
 *   - Vertical: `concurrency` proofs per instance, each in its own
 *     throwaway redis-server with its own memory ceiling.
 *   - Fleet-wide: `maxInFlight` caps how many proofs run at once across the
 *     whole fleet, so a burst of proofs cannot OOM the cluster.
 *   - Idle cost: one index-only scan of an empty partial index, backing off
 *     from the poll interval to the idle cap.
 */
import type { RedisFingerprint } from "@revenant/shared";

import type { Database } from "../db/index.js";
import {
  claimNextRedisProof,
  completeRedisProofRun,
  releaseRedisProof,
  type RedisProofClaim,
} from "../services/redis-snapshots.service.js";
import {
  runRedisRestoreProof,
  type RedisSandboxResult,
} from "../lib/redis-sandbox.js";

export interface RedisProofWorkerOptions {
  db: Database;
  masterKey: string;
  /** Proofs this instance may run at once. */
  concurrency?: number;
  /** Poll interval when there is work. */
  intervalMs?: number;
  /** Poll interval ceiling when the queue is empty. */
  maxIdleIntervalMs?: number;
  label?: string;
  /** Identifies this executor on the proof row. */
  workerId?: string;
  /** Fleet-wide cap on proofs running at once. 0 disables the check. */
  maxInFlight?: number;
  /** Keys sampled for the keyspace digest. */
  sampleSize?: number;
  /** Memory ceiling for each throwaway redis-server. */
  maxMemory?: string;
  /** Budget for pull + boot + inspect. */
  timeoutMs?: number;
  serverBin?: string;
  cliBin?: string;
}

/** How long the cloud worker waits before retrying a host it could not reach. */
const UNREACHABLE_RETRY_MS = 5 * 60 * 1000;

/**
 * Turn a sandbox result into the fingerprint the ledger stores.
 *
 * Digests only — never a raw key or value. The digest is computed inside
 * the sandbox with redis.sha1hex, so no customer data ever entered this
 * process.
 */
export function toFingerprint(
  result: RedisSandboxResult,
  keyspace: Record<string, { keys: number; expires: number; avgTtl: number | null }>
): RedisFingerprint {
  let totalKeys = 0;
  let totalExpires = 0;
  for (const entry of Object.values(keyspace)) {
    totalKeys += entry.keys;
    totalExpires += entry.expires;
  }
  return {
    source: "restored_rdb",
    version: result.restoredVersion,
    mode: null,
    keyspace,
    totalKeys,
    totalExpires,
    usedMemoryBytes: null,
    maxmemoryBytes: null,
    maxmemoryPolicy: null,
    // The API contract requires this field; the proof only ever reports
    // whether a password is set, never the value.
    requirepass: "NOT SET",
    appendOnly: null,
    savePolicy: null,
    sampleDigest: result.restoredDigest,
    sampledKeys: result.sampledKeys ?? 0,
    capturedAt: new Date().toISOString(),
  };
}

/**
 * What the queue should do with a finished attempt.
 *
 * This is the decision the whole redesign turns on, so it is a pure function
 * with its own tests:
 *
 *   - "complete" — the proof ran. Either the backup restored, or it did not
 *     and we now know the backup is bad. Both are answers.
 *   - "release"  — we could not reach the Redis. The backup was never
 *     tested, so failing the run would be a lie. Hand it back to the queue
 *     for an executor inside the customer's network.
 */
export type ProofDisposition = "complete" | "release";

export function decideProofDisposition(result: RedisSandboxResult): ProofDisposition {
  return result.outcome === "unreachable" ? "release" : "complete";
}

/**
 * Run one claimed proof to completion.
 *
 * Exported so a test (or a one-shot admin command) can drive a single proof
 * without starting the loop.
 */
export async function executeRedisProofClaim(
  opts: RedisProofWorkerOptions,
  claim: RedisProofClaim
): Promise<"completed" | "released" | "failed"> {
  const { db } = opts;

  const result = await runRedisRestoreProof({
    redisUrl: claim.redisUrl,
    sampleSize: opts.sampleSize,
    maxMemory: opts.maxMemory,
    timeoutMs: opts.timeoutMs,
    serverBin: opts.serverBin,
    cliBin: opts.cliBin,
    // Only pull the bytes when the API reserved a slot with a TTL for them.
    captureRdb: claim.captureRdb,
  });

  const firstMessage = result.messages[0] ?? null;

  // We could not reach the Redis. The backup was never tested, so the proof
  // must NOT be failed — hand it back to the queue for an executor that can
  // reach the host (an agent inside the customer's network).
  if (decideProofDisposition(result) === "release") {
    await releaseRedisProof(db, claim.proofId, {
      errorMessage:
        firstMessage ??
        "Revenant's cloud runner could not reach this Redis from the cloud.",
      kind: "unreachable",
      nextAttemptAt: new Date(Date.now() + UNREACHABLE_RETRY_MS),
    });
    return "released";
  }

  const restored = result.restored;
  const errorMessage = restored ? null : firstMessage;

  await completeRedisProofRun(db, claim.organizationId, claim.proofId, {
    restored,
    checks: result.checks,
    sourceKeyCount: result.sourceKeyCount,
    restoredKeyCount: result.restoredKeyCount,
    rdbBytes: result.rdbBytes,
    restoreSeconds: result.restoreSeconds,
    rpoObservedSeconds: result.rpoObservedSeconds,
    rdbLastBgsaveStatus: result.rdbLastBgsaveStatus,
    metadata: toFingerprint(result, buildRestoredKeyspace(result)),
    errorMessage,
    rdb: result.rdb ?? null,
    // A proof that RAN and found a bad backup is a `fail`. A proof that
    // could not run is an `error`. Conflating them sends customers hunting
    // for a backup problem they do not have.
    outcome: restored ? "pass" : "fail",
  });

  return "completed";
}

/**
 * The restored instance's keyspace, per database.
 *
 * This is the RESTORED data, read from the sandbox's own INFO keyspace
 * during the proof — the only data that proves anything.
 */
function buildRestoredKeyspace(
  result: RedisSandboxResult
): Record<string, { keys: number; expires: number; avgTtl: number | null }> {
  if (Object.keys(result.restoredKeyspace).length > 0) {
    return result.restoredKeyspace;
  }
  // An empty keyspace is a legitimate answer (the cache had no keys).
  if (result.restoredKeyCount != null) {
    return {
      db0: { keys: result.restoredKeyCount, expires: 0, avgTtl: null },
    };
  }
  return {};
}

/**
 * Start the managed Redis proof worker.
 *
 * Returns a stop function. Safe to call on every API instance: the claim is
 * a SKIP LOCKED row lock, so instances share the queue without coordination.
 */
export function startRedisProofWorker(opts: RedisProofWorkerOptions): () => void {
  const baseIntervalMs = opts.intervalMs ?? 5_000;
  const maxIntervalMs = opts.maxIdleIntervalMs ?? 60_000;
  const concurrency = Math.max(1, opts.concurrency ?? 1);
  const label = opts.label ?? "redis-proof-worker";
  const workerId = opts.workerId ?? `cloud:${process.env.HOSTNAME ?? "api"}`;

  let stopped = false;
  let consecutiveIdle = 0;
  let timer: NodeJS.Timeout | undefined;
  let active = 0;

  console.log(
    `[${label}] managed Redis proof worker online — concurrency=${concurrency} ` +
      `poll=${baseIntervalMs}ms (idle cap ${maxIntervalMs}ms) worker=${workerId}`
  );

  const schedule = () => {
    if (stopped) return;
    const delay = Math.min(
      baseIntervalMs * 2 ** Math.min(consecutiveIdle, 4),
      maxIntervalMs
    );
    timer = setTimeout(tick, delay);
  };

  const claimOne = async (): Promise<RedisProofClaim | null> => {
    try {
      return await claimNextRedisProof(opts.db, opts.masterKey, {
        mode: "cloud",
        workerId,
        maxInFlight: opts.maxInFlight,
      });
    } catch (err) {
      console.error(
        `[${label}] claim failed:`,
        err instanceof Error ? err.message : err
      );
      return null;
    }
  };

  const runOne = async (claim: RedisProofClaim) => {
    try {
      const outcome = await executeRedisProofClaim(opts, claim);
      if (outcome === "completed") {
        console.log(
          `[${label}] completed proof ${claim.proofId} for ${claim.resourceName}`
        );
      } else if (outcome === "released") {
        console.warn(
          `[${label}] released proof ${claim.proofId} for ${claim.resourceName} — ` +
            `the cloud could not reach that Redis; waiting for an agent on the customer's network`
        );
      }
    } catch (err) {
      // A thrown proof must still close the run, otherwise it burns the
      // customer's monthly quota with nothing to show for it.
      console.error(
        `[${label}] proof ${claim.proofId} failed:`,
        err instanceof Error ? err.message : err
      );
      await releaseRedisProof(opts.db, claim.proofId, {
        errorMessage:
          err instanceof Error ? err.message : "The Redis proof could not be completed.",
        kind: "failed",
        nextAttemptAt: new Date(Date.now() + UNREACHABLE_RETRY_MS),
      }).catch(() => undefined);
    }
  };

  const tick = async () => {
    if (stopped) return;
    let claimed = 0;
    try {
      while (!stopped && active < concurrency) {
        const claim = await claimOne();
        if (!claim) break;
        claimed += 1;
        active += 1;
        void runOne(claim).finally(() => {
          active -= 1;
        });
      }
    } catch (err) {
      console.error(
        `[${label}] poll failed:`,
        err instanceof Error ? err.message : err
      );
    } finally {
      // Work was found → poll again at the base rate. Nothing to do → back off.
      consecutiveIdle = claimed > 0 ? 0 : consecutiveIdle + 1;
      schedule();
    }
  };

  void tick();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
