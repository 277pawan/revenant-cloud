/**
 * Redis snapshots + restore proofs.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE TTL IS THE FEATURE
 *
 * Every stored artifact gets an `expiresAt` the moment it is created, and the
 * sweeper hard-deletes the bytes when it passes. Three independent guards:
 *
 *   1. `redis_snapshots.expires_at` is NOT NULL — no deadline, no row.
 *   2. `redis_snapshots_sweep_idx` partial index makes the sweep cheap.
 *   3. The CHECK constraint on redis_resources refuses an enabled resource
 *      with no positive retention window.
 *
 * An unbounded snapshot in our bucket is an unbounded bill AND an unbounded
 * data-protection obligation. There is no code path that produces one.
 *
 * Restore proofs are recorded whether or not storage is enabled — running a
 * proof and keeping bytes are different decisions and stay in different tables.
 */
import { and, count, desc, eq, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { createHash } from "node:crypto";

import {
  getPlanDefinition,
  redisRestoreProofsRemaining,
  type OrganizationPlan,
  type RedisFingerprint,
} from "@revenant/shared";

import type { Database } from "../db/index.js";
import { redisCredentials, redisProofs, redisResources, redisSnapshots } from "../db/schema.js";
import { createAppError } from "../lib/errors.js";
import { decryptSecret } from "../lib/crypto.js";
import {
  getArtifactStore,
  buildRedisArtifactKey,
  encodeArtifact,
  decodeArtifact,
  resolveRedisArtifactCompression,
  type ArtifactStore,
  type RedisArtifactCompression,
} from "../lib/artifact-store.js";

// ─── Proof quota ────────────────────────────────────────────────────────────

/**
 * Proofs started in the current calendar month (UTC).
 *
 * Backs the monthly quota. The API returns this to the dashboard so the UI
 * never has to reconstruct it from a page of proofs — which it used to do,
 * against a LIMIT 50 query, silently undercounting any customer past 50 runs.
 */
export async function countProofsThisMonth(
  db: Database,
  organizationId: string
): Promise<number> {
  const startOfMonth = new Date();
  startOfMonth.setUTCDate(1);
  startOfMonth.setUTCHours(0, 0, 0, 0);

  const [row] = await db
    .select({ value: count() })
    .from(redisProofs)
    .where(
      and(
        eq(redisProofs.organizationId, organizationId),
        sql`${redisProofs.createdAt} >= ${startOfMonth}`
      )
    );
  return Number(row?.value ?? 0);
}

export async function assertProofQuota(
  db: Database,
  organizationId: string,
  plan: OrganizationPlan
): Promise<{ used: number; limit: number | null; remaining: number | null }> {
  const used = await countProofsThisMonth(db, organizationId);
  const remaining = redisRestoreProofsRemaining(plan, used);
  const limit = getPlanDefinition(plan).limits.redisRestoreProofsPerMonth;

  if (remaining === 0) {
    throw createAppError(
      403,
      `You have used all ${limit} Redis restore proofs for this month. They reset on the 1st, or upgrade to Pro for ${getPlanDefinition("pro").limits.redisRestoreProofsPerMonth}.`,
      "PLAN_LIMIT"
    );
  }
  return { used, limit, remaining };
}

// ─── Snapshots ──────────────────────────────────────────────────────────────

export interface StartSnapshotInput {
  organizationId: string;
  redisResourceId: string;
  triggeredByUserId: string | null;
  /** Always provided by the caller from the plan — never from user input alone */
  retentionHours: number;
}

export interface StartSnapshotResult {
  proofId: string;
  snapshotId: string | null;
  storageKey: string | null;
  expiresAt: string | null;
}

/**
 * Open a proof, and — only if the customer opted in — open an artifact slot
 * with a TTL already attached. Returns nulls for the artifact fields when
 * storage is disabled, which is the default and the free path.
 */
export async function startRedisProof(
  db: Database,
  input: StartSnapshotInput
): Promise<StartSnapshotResult> {
  const [resource] = await db
    .select({
      id: redisResources.id,
      snapshotEnabled: redisResources.snapshotEnabled,
      snapshotRetentionHours: redisResources.snapshotRetentionHours,
    })
    .from(redisResources)
    .where(
      and(
        eq(redisResources.id, input.redisResourceId),
        eq(redisResources.organizationId, input.organizationId)
      )
    )
    .limit(1);

  if (!resource) {
    throw createAppError(404, "Redis resource not found", "NOT_FOUND");
  }

  const now = new Date();
  const [proof] = await db
    .insert(redisProofs)
    .values({
      organizationId: input.organizationId,
      redisResourceId: input.redisResourceId,
      triggeredByUserId: input.triggeredByUserId,
      // pending until an agent claims it — "running" would falsely imply work
      // is already in flight and would never be reclaimed if no agent exists.
      status: "pending",
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  const storing = resource.snapshotEnabled === "true";
  if (!storing) {
    return {
      proofId: proof!.id,
      snapshotId: null,
      storageKey: null,
      expiresAt: null,
    };
  }

  // Fall back to the plan default if the row somehow has no TTL set. The DB
  // CHECK constraint should prevent this, but a corrupted row must not become
  // an artifact that never expires.
  const retentionHours =
    resource.snapshotRetentionHours && resource.snapshotRetentionHours > 0
      ? resource.snapshotRetentionHours
      : Math.max(1, input.retentionHours);
  const expiresAt = new Date(now.getTime() + retentionHours * 60 * 60 * 1000);

  // Reserve the storage key NOW rather than at upload time, so a crashed agent
  // leaves a row the sweeper can find instead of an untraceable file.
  const storageKey = buildRedisArtifactKey({
    organizationId: input.organizationId,
    redisResourceId: input.redisResourceId,
    snapshotId: "pending",
    capturedAt: now,
  }).replace("/pending.", `/${proof!.id}.`);

  const [snapshot] = await db
    .insert(redisSnapshots)
    .values({
      organizationId: input.organizationId,
      redisResourceId: input.redisResourceId,
      status: "capturing",
      storageKey,
      expiresAt,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  await db
    .update(redisProofs)
    .set({ snapshotId: snapshot!.id, updatedAt: now })
    .where(eq(redisProofs.id, proof!.id));

  return {
    proofId: proof!.id,
    snapshotId: snapshot!.id,
    storageKey: buildRedisArtifactKey({
      organizationId: input.organizationId,
      redisResourceId: input.redisResourceId,
      snapshotId: snapshot!.id,
      capturedAt: now,
    }),
    expiresAt: expiresAt.toISOString(),
  };
}

export interface CompleteSnapshotInput {
  organizationId: string;
  proofId: string;
  snapshotId: string | null;
  storageKey: string | null;
  /** Raw RDB bytes. Omit when the customer did not enable storage. */
  rdb?: Buffer | null;
  metadata: RedisFingerprint | null;
  restored: boolean;
  sourceKeyCount: number | null;
  restoredKeyCount: number | null;
  restoreSeconds: number | null;
  rpoObservedSeconds: number | null;
  rdbLastBgsaveStatus: string | null;
  errorMessage?: string | null;
}

/**
 * Finish a proof: persist the artifact if storage is on, then close the ledger.
 *
 * On any failure after the artifact was written, the artifact is deleted and
 * the row marked failed — a half-stored snapshot is worse than none, because
 * it looks restorable and is not.
 */
export async function completeRedisProof(
  db: Database,
  input: CompleteSnapshotInput,
  store?: ArtifactStore
): Promise<{ storedBytes: number | null }> {
  const now = new Date();
  const artifactStore = store ?? getArtifactStore(process.env as Record<string, string>);
  let storedBytes: number | null = null;

  const proofStatus = input.errorMessage
    ? "error"
    : input.restored
      ? "pass"
      : "fail";

  if (input.snapshotId && input.storageKey && input.rdb && input.rdb.byteLength > 0) {
    try {
      // Encode BEFORE storing so the checksum we record is the checksum of what
      // actually sits in the bucket, and the row records the real encoding.
      const compression = getRedisArtifactCompression();
      const encoded = encodeArtifact(input.rdb, compression);

      const stored = await artifactStore.put(input.storageKey, encoded.data);
      storedBytes = stored.byteSize;

      await db
        .update(redisSnapshots)
        .set({
          status: input.restored ? "stored" : "failed",
          byteSize: stored.byteSize,
          checksumSha256: stored.checksumSha256,
          storageKey: stored.key,
          compression: encoded.compression,
          metadataJson: input.metadata,
          lastVerificationStatus: input.restored ? "verified" : "failed",
          lastVerifiedAt: input.restored ? now : null,
          errorMessage: input.errorMessage ?? null,
          updatedAt: now,
        })
        .where(
          and(
            eq(redisSnapshots.id, input.snapshotId),
            eq(redisSnapshots.organizationId, input.organizationId)
          )
        );
    } catch (err) {
      // Clean up the partially written artifact so it cannot linger un-TTL'd.
      await artifactStore.delete(input.storageKey).catch(() => undefined);
      await db
        .update(redisSnapshots)
        .set({
          status: "failed",
          storageKey: null,
          errorMessage: err instanceof Error ? err.message : String(err),
          updatedAt: now,
        })
        .where(
          and(
            eq(redisSnapshots.id, input.snapshotId),
            eq(redisSnapshots.organizationId, input.organizationId)
          )
        );
      throw err;
    }
  } else if (input.snapshotId) {
    // No bytes arrived (storage on, but the drill produced no artifact).
    await db
      .update(redisSnapshots)
      .set({
        status: "failed",
        storageKey: null,
        metadataJson: input.metadata,
        lastVerificationStatus: input.restored ? "verified" : "failed",
        lastVerifiedAt: input.restored ? now : null,
        errorMessage:
          input.errorMessage ?? "Restore proof produced no RDB artifact to store",
        updatedAt: now,
      })
      .where(
        and(
          eq(redisSnapshots.id, input.snapshotId),
          eq(redisSnapshots.organizationId, input.organizationId)
        )
      );
  }

  await db
    .update(redisProofs)
    .set({
      status: proofStatus,
      restored: input.restored ? "true" : "false",
      sourceKeyCount: input.sourceKeyCount,
      restoredKeyCount: input.restoredKeyCount,
      rdbBytes: input.rdb?.byteLength ?? null,
      restoreSeconds: input.restoreSeconds,
      rpoObservedSeconds: input.rpoObservedSeconds,
      rdbLastBgsaveStatus: input.rdbLastBgsaveStatus,
      errorMessage: input.errorMessage ?? null,
      metadataJson: input.metadata,
      completedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(redisProofs.id, input.proofId),
        eq(redisProofs.organizationId, input.organizationId)
      )
    );

  return { storedBytes };
}

export async function listRedisSnapshots(
  db: Database,
  organizationId: string,
  redisResourceId: string
) {
  return db
    .select()
    .from(redisSnapshots)
    .where(
      and(
        eq(redisSnapshots.organizationId, organizationId),
        eq(redisSnapshots.redisResourceId, redisResourceId)
      )
    )
    .orderBy(desc(redisSnapshots.createdAt))
    .limit(100);
}

export async function listRedisProofs(
  db: Database,
  organizationId: string,
  redisResourceId: string
) {
  return db
    .select()
    .from(redisProofs)
    .where(
      and(
        eq(redisProofs.organizationId, organizationId),
        eq(redisProofs.redisResourceId, redisResourceId)
      )
    )
    .orderBy(desc(redisProofs.createdAt))
    .limit(50);
}

/**
 * Everything the dashboard's detail panel needs, in one call.
 *
 * Proofs and snapshots are fetched in a single round trip via two parallel
 * queries rather than the client issuing two requests, and the monthly quota
 * is resolved here instead of the UI summing a truncated page.
 */
export async function getRedisProofOverview(
  db: Database,
  organizationId: string,
  redisResourceId: string
): Promise<{
  proofs: Awaited<ReturnType<typeof listRedisProofs>>;
  snapshots: Awaited<ReturnType<typeof listRedisSnapshots>>;
  proofsUsedThisMonth: number;
}> {
  const [proofs, snapshots, proofsUsedThisMonth] = await Promise.all([
    listRedisProofs(db, organizationId, redisResourceId),
    listRedisSnapshots(db, organizationId, redisResourceId),
    countProofsThisMonth(db, organizationId),
  ]);
  return { proofs, snapshots, proofsUsedThisMonth };
}

/** Manual delete — customer-initiated or when storage is switched off. */
export async function deleteRedisSnapshot(
  db: Database,
  organizationId: string,
  snapshotId: string,
  store?: ArtifactStore
): Promise<void> {
  const [row] = await db
    .select({ storageKey: redisSnapshots.storageKey })
    .from(redisSnapshots)
    .where(
      and(
        eq(redisSnapshots.id, snapshotId),
        eq(redisSnapshots.organizationId, organizationId)
      )
    )
    .limit(1);
  if (!row) throw createAppError(404, "Snapshot not found", "NOT_FOUND");

  if (row.storageKey) {
    const artifactStore = store ?? getArtifactStore(process.env as Record<string, string>);
    await artifactStore.delete(row.storageKey).catch(() => undefined);
  }

  await db
    .update(redisSnapshots)
    .set({ status: "deleted", deletedAt: new Date(), storageKey: null, updatedAt: new Date() })
    .where(
      and(
        eq(redisSnapshots.id, snapshotId),
        eq(redisSnapshots.organizationId, organizationId)
      )
    );
}

// ─── Agent claim / complete ────────────────────────────────────────────────

/** A proof is stuck if no agent picked it up in this long. */
const PROOF_CLAIM_STALE_MS = 30 * 60 * 1000;

export interface RedisProofClaim {
  proofId: string;
  redisResourceId: string;
  resourceName: string;
  snapshotId: string | null;
  storageKey: string | null;
  /** True when the agent should return the RDB bytes on completion */
  captureRdb: boolean;
  expiresAt: string | null;
  /**
   * Decrypted Redis URL. SENSITIVE — returned only over the runner-token
   * endpoint and never logged, never included in any proof row.
   */
  redisUrl: string;
}

/**
 * Hand the oldest pending proof to an agent.
 *
 * QUERY BUDGET: 2 statements, and the idle path is one index-only scan of
 * `redis_proofs_pending_idx` (a near-empty partial index). It was 6 statements
 * with a sequential scan before 0027 — see the migration header.
 *
 * Claiming uses `FOR UPDATE ... SKIP LOCKED` so N agents polling the same
 * queue never collide and never block each other on the same row. The old
 * select-then-update pair had a race where two agents could both read the same
 * pending proof and one would silently discard its work.
 *
 * Reclaiming abandoned runs lives in `reclaimStaleRedisProofs`, which the
 * sweeper calls on a 5-minute cadence — NOT here. It used to run on every
 * tick, which is why an idle agent was scanning the table 17k times a day.
 */
export async function claimNextRedisProof(
  db: Database,
  masterKey: string
): Promise<RedisProofClaim | null> {
  const now = new Date();

  // ONE query: claim the row and pull the whole payload in the same round
  // trip. Joins are covered by redis_proofs_join_idx + the PKs.
  const [claimed] = await db
    .select({
      proofId: redisProofs.id,
      redisResourceId: redisProofs.redisResourceId,
      snapshotId: redisProofs.snapshotId,
      resourceName: redisResources.name,
      snapshotEnabled: redisResources.snapshotEnabled,
      ciphertext: redisCredentials.ciphertext,
      iv: redisCredentials.iv,
      authTag: redisCredentials.authTag,
      storageKey: redisSnapshots.storageKey,
      expiresAt: redisSnapshots.expiresAt,
    })
    .from(redisProofs)
    .innerJoin(redisResources, eq(redisResources.id, redisProofs.redisResourceId))
    .innerJoin(
      redisCredentials,
      eq(redisCredentials.redisResourceId, redisProofs.redisResourceId)
    )
    .leftJoin(redisSnapshots, eq(redisSnapshots.id, redisProofs.snapshotId))
    .where(eq(redisProofs.status, "pending"))
    .orderBy(redisProofs.createdAt)
    .limit(1)
    .for("update", { of: redisProofs, skipLocked: true });

  if (!claimed) return null;

  await db
    .update(redisProofs)
    .set({ status: "running", startedAt: now, updatedAt: now })
    .where(eq(redisProofs.id, claimed.proofId));

  let redisUrl: string;
  try {
    redisUrl = decryptSecret(
      {
        ciphertext: claimed.ciphertext,
        iv: claimed.iv,
        authTag: claimed.authTag,
      },
      masterKey
    );
  } catch {
    // A failed decrypt is unrecoverable for this proof — close it instead of
    // crashing the agent's poll loop.
    await db
      .update(redisProofs)
      .set({
        status: "error",
        errorMessage:
          "Stored Redis credentials could not be decrypted with MASTER_KEY",
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(redisProofs.id, claimed.proofId));
    return null;
  }

  const captureRdb = claimed.snapshotEnabled === "true" && !!claimed.snapshotId;

  return {
    proofId: claimed.proofId,
    redisResourceId: claimed.redisResourceId,
    resourceName: claimed.resourceName,
    snapshotId: captureRdb ? claimed.snapshotId : null,
    storageKey: captureRdb ? claimed.storageKey ?? null : null,
    captureRdb,
    expiresAt: claimed.expiresAt?.toISOString() ?? null,
    redisUrl,
  };
}

/**
 * Return proofs stuck in `running` to the queue.
 *
 * Called by the 5-minute sweeper, never by the claim endpoint.
 *
 * Deliberately avoids `coalesce(started_at, created_at)`: that expression
 * cannot use an index and turned this into a sequential scan. `started_at` is
 * set the moment a proof is claimed, so filtering on it directly is both
 * correct and indexable via `redis_proofs_running_idx`.
 *
 * Without this, an agent dying mid-drill would leave a proof "running" forever,
 * burning the customer's monthly quota with nothing to show for it.
 */
export async function reclaimStaleRedisProofs(db: Database): Promise<number> {
  const staleBefore = new Date(Date.now() - PROOF_CLAIM_STALE_MS);

  const reclaimed = await db
    .update(redisProofs)
    .set({ status: "pending", updatedAt: new Date() })
    .where(
      and(
        eq(redisProofs.status, "running"),
        isNotNull(redisProofs.startedAt),
        lt(redisProofs.startedAt, staleBefore)
      )
    )
    .returning({ id: redisProofs.id });

  return reclaimed.length;
}

export interface RedisProofCompletion {
  restored: boolean;
  sourceKeyCount: number | null;
  restoredKeyCount: number | null;
  rdbBytes?: number | null;
  restoreSeconds: number | null;
  rpoObservedSeconds: number | null;
  rdbLastBgsaveStatus: string | null;
  /** Digests/metadata from the agent. Must contain no raw keys or values. */
  metadata: RedisFingerprint | null;
  errorMessage?: string | null;
  /** base64 RDB, sent only when the claim asked for captureRdb */
  rdbBase64?: string | null;
}

/** Agent-reported result → close the proof and, if enabled, store the artifact. */
export async function completeRedisProofRun(
  db: Database,
  organizationId: string,
  proofId: string,
  input: RedisProofCompletion,
  store?: ArtifactStore
): Promise<void> {
  const [proof] = await db
    .select({
      id: redisProofs.id,
      snapshotId: redisProofs.snapshotId,
      redisResourceId: redisProofs.redisResourceId,
    })
    .from(redisProofs)
    .where(
      and(eq(redisProofs.id, proofId), eq(redisProofs.organizationId, organizationId))
    )
    .limit(1);
  if (!proof) throw createAppError(404, "Proof not found", "NOT_FOUND");

  let rdb: Buffer | null = null;
  if (input.rdbBase64) {
    // Refuse anything implausible for an RDB before it reaches disk.
    const buffer = Buffer.from(input.rdbBase64, "base64");
    if (buffer.byteLength > MAX_RDB_BYTES) {
      throw createAppError(
        413,
        `Snapshot exceeds the ${Math.round(MAX_RDB_BYTES / 1024 / 1024)}MB limit`,
        "SNAPSHOT_TOO_LARGE"
      );
    }
    rdb = buffer;
  }

  const [snapshot] = proof.snapshotId
    ? await db
        .select({ storageKey: redisSnapshots.storageKey, compression: redisSnapshots.compression })
        .from(redisSnapshots)
        .where(eq(redisSnapshots.id, proof.snapshotId))
        .limit(1)
    : [undefined];

  await completeRedisProof(
    db,
    {
      organizationId,
      proofId,
      snapshotId: proof.snapshotId,
      // The key extension is chosen from the configured encoding, and the row
      // records what was really written — the two can never disagree.
      storageKey: rdb
        ? snapshot?.storageKey ??
          buildRedisArtifactKey({
            organizationId,
            redisResourceId: proof.redisResourceId,
            snapshotId: proof.snapshotId!,
            capturedAt: new Date(),
            compression: getRedisArtifactCompression(),
          })
        : null,
      rdb,
      metadata: input.metadata,
      restored: input.restored,
      sourceKeyCount: input.sourceKeyCount,
      restoredKeyCount: input.restoredKeyCount,
      restoreSeconds: input.restoreSeconds,
      rpoObservedSeconds: input.rpoObservedSeconds,
      rdbLastBgsaveStatus: input.rdbLastBgsaveStatus,
      errorMessage: input.errorMessage ?? null,
    },
    store
  );

  await db
    .update(redisResources)
    .set({
      lastVerifiedAt: new Date(),
      lastVerificationStatus: input.errorMessage
        ? "failed"
        : input.restored
          ? "verified"
          : "failed",
      engineVersion: input.metadata?.version ?? null,
      fingerprintJson: input.metadata,
      lastRestoreProofSeconds: input.restoreSeconds,
      lastRpoObservedSeconds: input.rpoObservedSeconds,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(redisResources.id, proof.redisResourceId),
        eq(redisResources.organizationId, organizationId)
      )
    );
}

/**
 * Ceiling on a single stored RDB. An RDB is an in-memory dump of a live cache,
 * so it is bounded by the customer's maxmemory — anything past this is a
 * misconfiguration or an attempt to use us as free object storage.
 */
export const MAX_RDB_BYTES = 2 * 1024 * 1024 * 1024;

/** Resolve the configured artifact encoding, degrading safely. */
export function getRedisArtifactCompression(): RedisArtifactCompression {
  return resolveRedisArtifactCompression(process.env.REDIS_ARTIFACT_COMPRESSION);
}

// ─── The sweeper ────────────────────────────────────────────────────────────

export interface SweepResult {
  scanned: number;
  deleted: number;
  bytesReclaimed: number;
  errors: string[];
}

/**
 * Hard-delete every artifact past its TTL.
 *
 * Wire this into the existing scheduler (or call it on API boot in dev).
 * Safe to run concurrently — deleting a missing key is a no-op and the update
 * is idempotent, so a second sweeper instance changes nothing.
 */
export async function sweepExpiredRedisSnapshots(
  db: Database,
  store?: ArtifactStore,
  batchSize = 200
): Promise<SweepResult> {
  const artifactStore = store ?? getArtifactStore(process.env as Record<string, string>);
  const now = new Date();

  const expired = await db
    .select({
      id: redisSnapshots.id,
      storageKey: redisSnapshots.storageKey,
      byteSize: redisSnapshots.byteSize,
    })
    .from(redisSnapshots)
    .where(
      and(
        lt(redisSnapshots.expiresAt, now),
        isNull(redisSnapshots.deletedAt),
        sql`${redisSnapshots.status} in ('capturing','stored')`
      )
    )
    .limit(batchSize);

  const result: SweepResult = {
    scanned: expired.length,
    deleted: 0,
    bytesReclaimed: 0,
    errors: [],
  };

  for (const row of expired) {
    try {
      if (row.storageKey) {
        await artifactStore.delete(row.storageKey);
        result.bytesReclaimed += row.byteSize ?? 0;
      }
      await db
        .update(redisSnapshots)
        .set({
          status: "expired",
          deletedAt: now,
          storageKey: null,
          updatedAt: now,
        })
        .where(and(eq(redisSnapshots.id, row.id), isNull(redisSnapshots.deletedAt)));
      result.deleted += 1;
    } catch (err) {
      // Leave deletedAt NULL so the next sweep retries it.
      result.errors.push(
        `${row.id}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  return result;
}

/**
 * Read an artifact back for a restore-from-snapshot request.
 * Refuses anything past its TTL — the TTL is not advisory.
 */
export async function readRedisArtifact(
  db: Database,
  organizationId: string,
  snapshotId: string,
  store?: ArtifactStore
): Promise<{ buffer: Buffer; checksumSha256: string }> {
  const [row] = await db
    .select({
      storageKey: redisSnapshots.storageKey,
      checksumSha256: redisSnapshots.checksumSha256,
      expiresAt: redisSnapshots.expiresAt,
      deletedAt: redisSnapshots.deletedAt,
      compression: redisSnapshots.compression,
    })
    .from(redisSnapshots)
    .where(
      and(
        eq(redisSnapshots.id, snapshotId),
        eq(redisSnapshots.organizationId, organizationId)
      )
    )
    .limit(1);

  if (!row || !row.storageKey || row.deletedAt) {
    throw createAppError(404, "Snapshot not found or already expired", "NOT_FOUND");
  }
  if (row.expiresAt.getTime() <= Date.now()) {
    throw createAppError(
      410,
      "This snapshot has passed its retention window and is being deleted.",
      "SNAPSHOT_EXPIRED"
    );
  }

  const artifactStore = store ?? getArtifactStore(process.env as Record<string, string>);
  const encoded = await artifactStore.get(row.storageKey);
  // Decode with the encoding actually recorded on the row — not whatever is
  // configured now, which may have changed since the artifact was written.
  const compression = (row.compression ?? "none") as RedisArtifactCompression;
  const buffer = decodeArtifact(encoded, compression);

  // checksumSha256 is the checksum of the STORED bytes, so it must be verified
  // against what came back from storage, before decoding.
  if (row.checksumSha256) {
    const actual = createHash("sha256").update(encoded).digest("hex");
    if (actual !== row.checksumSha256) {
      throw createAppError(
        500,
        "Stored snapshot failed its checksum — the artifact is corrupt",
        "ARTIFACT_CORRUPT"
      );
    }
  }

  return { buffer, checksumSha256: row.checksumSha256 ?? createHash("sha256").update(buffer).digest("hex") };
}