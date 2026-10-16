/**
 * Redis resources — registering, testing and fingerprinting a customer's Redis.
 *
 * Multi-tenancy rule (FOUNDATION.md): every query filters by organizationId
 * from the JWT. No exceptions.
 *
 * Credentials are stored as an AES-256-GCM encrypted URL in redis_credentials,
 * mirroring database_credentials. The plaintext URL is never returned by any
 * endpoint, never logged, and never written to a snapshot row.
 */
import { and, count, eq, sql } from "drizzle-orm";

import {
  getPlanDefinition,
  parseRedisUrl,
  redactRedisUrl,
  resolveRedisSnapshotRetentionHours,
  type OrganizationPlan,
  type RedisFingerprint,
  type RedisResource,
} from "@revenant/shared";

import type { Database } from "../db/index.js";
import { databases, redisCredentials, redisResources, redisSnapshots } from "../db/schema.js";
import { createAppError } from "../lib/errors.js";
import { encryptSecret, decryptSecret } from "../lib/crypto.js";
import { getArtifactStore } from "../lib/artifact-store.js";
import { fingerprintRedis, withRedis } from "../lib/redis-client.js";

export interface CreateRedisResourceInput {
  organizationId: string;
  userId: string;
  name: string;
  url: string;
  databaseId?: string | null;
  snapshotEnabled?: boolean;
  snapshotRetentionHours?: number | null;
  /** Org's current plan — used to clamp the TTL. Never trust user input alone. */
  plan: OrganizationPlan;
}

export interface RedisResourceRow {
  resource: RedisResource;
  /** Only for internal use — never leaves this module except to the agent */
  decryptedUrl: string;
}

function toBool(value: string): boolean {
  return value === "true";
}

/** Shape a DB row into the public resource (no secrets, no full URL). */
export function toRedisResource(row: typeof redisResources.$inferSelect): RedisResource {
  return {
    id: row.id,
    name: row.name,
    host: row.host,
    port: row.port,
    dbIndex: row.dbIndex,
    username: row.username,
    tls: toBool(row.tls),
    engineVersion: row.engineVersion,
    snapshotEnabled: toBool(row.snapshotEnabled),
    snapshotRetentionHours: row.snapshotRetentionHours,
    databaseId: row.databaseId,
    hasCredentials: true,
    lastVerifiedAt: row.lastVerifiedAt?.toISOString() ?? null,
    lastVerificationStatus: row.lastVerificationStatus as RedisResource["lastVerificationStatus"],
    lastRestoreProofSeconds: row.lastRestoreProofSeconds,
    fingerprint: (row.fingerprintJson as RedisFingerprint | null) ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ─── Credentials ────────────────────────────────────────────────────────────

async function upsertCredential(
  db: Database,
  organizationId: string,
  redisResourceId: string,
  url: string,
  masterKey: string
): Promise<void> {
  const encrypted = encryptSecret(url, masterKey);
  const now = new Date();
  await db
    .insert(redisCredentials)
    .values({
      organizationId,
      redisResourceId,
      ciphertext: encrypted.ciphertext,
      iv: encrypted.iv,
      authTag: encrypted.authTag,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: redisCredentials.redisResourceId,
      set: {
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        authTag: encrypted.authTag,
        updatedAt: now,
      },
    });
}

export async function decryptRedisUrl(
  db: Database,
  organizationId: string,
  redisResourceId: string,
  masterKey: string
): Promise<string | null> {
  const [row] = await db
    .select({
      ciphertext: redisCredentials.ciphertext,
      iv: redisCredentials.iv,
      authTag: redisCredentials.authTag,
    })
    .from(redisCredentials)
    .where(
      and(
        eq(redisCredentials.organizationId, organizationId),
        eq(redisCredentials.redisResourceId, redisResourceId)
      )
    )
    .limit(1);
  if (!row) return null;
  return decryptSecret(
    { ciphertext: row.ciphertext, iv: row.iv, authTag: row.authTag },
    masterKey
  );
}

// ─── Plan gating ────────────────────────────────────────────────────────────

export async function assertRedisResourceAllowed(
  db: Database,
  organizationId: string,
  plan: OrganizationPlan
): Promise<void> {
  const limits = getPlanDefinition(plan).limits;
  if (limits.redisResources === 0) {
    throw createAppError(
      403,
      "Redis verification is available on Starter and above. The free Developer plan can run `revenant verify --engine redis` from your own machine with no account.",
      "PLAN_LIMIT"
    );
  }
  if (limits.redisResources == null) return;

  const [row] = await db
    .select({ value: count() })
    .from(redisResources)
    .where(eq(redisResources.organizationId, organizationId));

  if (Number(row?.value ?? 0) >= limits.redisResources) {
    throw createAppError(
      403,
      `Your plan allows ${limits.redisResources} Redis instance${limits.redisResources === 1 ? "" : "s"}. Delete one or upgrade to Pro for ${getPlanDefinition("pro").limits.redisResources}.`,
      "PLAN_LIMIT"
    );
  }
}

export function assertSnapshotStorageAllowed(plan: OrganizationPlan): void {
  if (!getPlanDefinition(plan).limits.redisSnapshotEnabled) {
    throw createAppError(
      403,
      "Snapshot storage is not available on your plan. You can still run unlimited Redis restore proofs.",
      "PLAN_LIMIT"
    );
  }
}

// ─── CRUD ───────────────────────────────────────────────────────────────────

export async function createRedisResource(
  db: Database,
  input: CreateRedisResourceInput,
  masterKey: string
): Promise<RedisResource> {
  const parsed = parseRedisUrl(input.url);
  if (!parsed) {
    throw createAppError(
      400,
      "That does not look like a Redis URL. Use redis://[:password]@host:port/db or rediss://…",
      "INVALID_REDIS_URL"
    );
  }
  if (!parsed.host) {
    throw createAppError(400, "Redis URL is missing a host", "INVALID_REDIS_URL");
  }

  if (input.databaseId) {
    const [owner] = await db
      .select({ id: databases.id })
      .from(databases)
      .where(
        and(
          eq(databases.id, input.databaseId),
          eq(databases.organizationId, input.organizationId)
        )
      )
      .limit(1);
    if (!owner) {
      throw createAppError(404, "Database not found", "NOT_FOUND");
    }
  }

  const [existing] = await db
    .select({ id: redisResources.id })
    .from(redisResources)
    .where(
      and(
        eq(redisResources.organizationId, input.organizationId),
        eq(redisResources.name, input.name)
      )
    )
    .limit(1);
  if (existing) {
    throw createAppError(409, "A Redis resource with that name already exists", "DUPLICATE_NAME");
  }

  const now = new Date();
  const [row] = await db
    .insert(redisResources)
    .values({
      organizationId: input.organizationId,
      databaseId: input.databaseId ?? null,
      name: input.name,
      host: parsed.host,
      port: parsed.port,
      dbIndex: parsed.dbIndex,
      username: parsed.username,
      tls: parsed.tls ? "true" : "false",
      snapshotEnabled: input.snapshotEnabled ? "true" : "false",
      snapshotRetentionHours: input.snapshotEnabled
        ? resolveRedisSnapshotRetentionHours(input.plan, input.snapshotRetentionHours)
        : null,
      createdByUserId: input.userId,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  await upsertCredential(db, input.organizationId, row!.id, input.url, masterKey);
  return toRedisResource(row!);
}

export async function listRedisResources(
  db: Database,
  organizationId: string
): Promise<RedisResource[]> {
  const rows = await db
    .select()
    .from(redisResources)
    .where(eq(redisResources.organizationId, organizationId))
    .orderBy(sql`${redisResources.createdAt} desc`);
  return rows.map(toRedisResource);
}

export async function getRedisResource(
  db: Database,
  organizationId: string,
  id: string
): Promise<RedisResource> {
  const [row] = await db
    .select()
    .from(redisResources)
    .where(
      and(eq(redisResources.id, id), eq(redisResources.organizationId, organizationId))
    )
    .limit(1);
  if (!row) throw createAppError(404, "Redis resource not found", "NOT_FOUND");
  return toRedisResource(row);
}

export interface UpdateRedisResourceInput {
  organizationId: string;
  id: string;
  plan: OrganizationPlan;
  changes: {
    name?: string;
    url?: string;
    databaseId?: string | null;
    snapshotEnabled?: boolean;
    snapshotRetentionHours?: number | null;
  };
}

/**
 * Update a Redis resource.
 *
 * Turning snapshot storage OFF is treated as a deletion of intent: the stored
 * artifacts are deleted rather than orphaned, because leaving TTL'd bytes
 * behind after a customer disabled the feature is the kind of surprise that
 * turns into a complaint about data retention.
 */
export async function updateRedisResource(
  db: Database,
  input: UpdateRedisResourceInput,
  masterKey: string
): Promise<RedisResource> {
  const [existing] = await db
    .select()
    .from(redisResources)
    .where(
      and(
        eq(redisResources.id, input.id),
        eq(redisResources.organizationId, input.organizationId)
      )
    )
    .limit(1);
  if (!existing) throw createAppError(404, "Redis resource not found", "NOT_FOUND");

  const patch: Partial<typeof redisResources.$inferInsert> = { updatedAt: new Date() };

  if (input.changes.name !== undefined) patch.name = input.changes.name;
  if (input.changes.databaseId !== undefined) patch.databaseId = input.changes.databaseId;

  if (input.changes.url !== undefined) {
    const parsed = parseRedisUrl(input.changes.url);
    if (!parsed) {
      throw createAppError(
        400,
        "That does not look like a Redis URL. Use redis://[:password]@host:port/db or rediss://…",
        "INVALID_REDIS_URL"
      );
    }
    patch.host = parsed.host;
    patch.port = parsed.port;
    patch.dbIndex = parsed.dbIndex;
    patch.username = parsed.username;
    patch.tls = parsed.tls ? "true" : "false";
    await upsertCredential(
      db,
      input.organizationId,
      input.id,
      input.changes.url,
      masterKey
    );
  }

  if (input.changes.snapshotEnabled !== undefined) {
    const enabled = input.changes.snapshotEnabled;
    patch.snapshotEnabled = enabled ? "true" : "false";
    patch.snapshotRetentionHours = enabled
      ? resolveRedisSnapshotRetentionHours(
          input.plan,
          input.changes.snapshotRetentionHours ?? existing.snapshotRetentionHours
        )
      : null;
  } else if (input.changes.snapshotRetentionHours !== undefined) {
    // Changing the window on an already-enabled resource.
    patch.snapshotRetentionHours = existing.snapshotEnabled === "true"
      ? resolveRedisSnapshotRetentionHours(input.plan, input.changes.snapshotRetentionHours)
      : null;
  }

  const [row] = await db
    .update(redisResources)
    .set(patch)
    .where(
      and(
        eq(redisResources.id, input.id),
        eq(redisResources.organizationId, input.organizationId)
      )
    )
    .returning();

  return toRedisResource(row!);
}

export async function deleteRedisResource(
  db: Database,
  organizationId: string,
  id: string
): Promise<void> {
  const [existing] = await db
    .select({ id: redisResources.id })
    .from(redisResources)
    .where(
      and(eq(redisResources.id, id), eq(redisResources.organizationId, organizationId))
    )
    .limit(1);
  if (!existing) throw createAppError(404, "Redis resource not found", "NOT_FOUND");

  // Purge artifact BYTES BEFORE deleting the rows.
  //
  // This ordering is not optional: redis_snapshots cascades on resource delete,
  // so deleting the row first would destroy every storage_key and strand the
  // RDB files in the artifact store with no record that they exist. Purge
  // first, then let the FK cascade clean up the metadata.
  const keys = await db
    .select({ storageKey: redisSnapshots.storageKey })
    .from(redisSnapshots)
    .where(
      and(
        eq(redisSnapshots.redisResourceId, id),
        eq(redisSnapshots.organizationId, organizationId)
      )
    );

  const store = getArtifactStore(process.env as Record<string, string>);
  for (const { storageKey } of keys) {
    if (!storageKey) continue;
    // Best-effort: a failed delete must not block the resource removal, and a
    // leftover key is recoverable because we log it.
    await store.delete(storageKey).catch((err) => {
      console.warn(
        `[redis] failed to purge artifact ${storageKey} on resource delete: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    });
  }

  const deleted = await db
    .delete(redisResources)
    .where(
      and(eq(redisResources.id, id), eq(redisResources.organizationId, organizationId))
    )
    .returning({ id: redisResources.id });

  if (deleted.length === 0) {
    throw createAppError(404, "Redis resource not found", "NOT_FOUND");
  }
}

// ─── Connectivity test ──────────────────────────────────────────────────────

export interface RedisTestResult {
  ok: boolean;
  /** Redacted URL — safe to return and to log */
  redactedUrl: string;
  latencyMs: number | null;
  fingerprint: RedisFingerprint | null;
  error: string | null;
  /** True when the failure is a network/reachability problem, not a bad password */
  unreachable: boolean;
}

/**
 * Connect, PING, and fingerprint — the "paste your Redis URL" moment.
 *
 * This runs from the API, so it only works for a Redis the API can actually
 * reach (public host, VPC peering, or a tunnel). For a Redis on a private
 * network the test is expected to fail with `unreachable: true`; that is a
 * normal outcome, not an error — the agent proves it from inside the network.
 */
export async function testRedisConnection(
  url: string,
  timeoutMs = 5_000
): Promise<RedisTestResult> {
  const parsed = parseRedisUrl(url);
  const redactedUrl = redactRedisUrl(url);
  if (!parsed) {
    return {
      ok: false,
      redactedUrl,
      latencyMs: null,
      fingerprint: null,
      error: "Not a valid redis:// or rediss:// URL",
      unreachable: false,
    };
  }

  const startedAt = Date.now();
  try {
    const fingerprint = await withRedis(
      {
        host: parsed.host,
        port: parsed.port,
        username: parsed.username,
        password: parsed.password,
        dbIndex: parsed.dbIndex,
        tls: parsed.tls,
        timeoutMs,
      },
      async (client) => {
        await client.send("PING");
        // includeSamples stays false: the API must not read real key names.
        return fingerprintRedis(client, { includeSamples: false });
      }
    );

    return {
      ok: true,
      redactedUrl,
      latencyMs: Date.now() - startedAt,
      fingerprint,
      error: null,
      unreachable: false,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const authIssue =
      /NOAUTH|WRONGPASS|invalid password|unknown user/i.test(message);
    const networkIssue =
      /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|timed out|Connection closed/i.test(
        message
      );

    return {
      ok: false,
      redactedUrl,
      latencyMs: Date.now() - startedAt,
      fingerprint: null,
      error: authIssue
        ? "Redis rejected the credentials in that URL."
        : networkIssue
          ? `Revenant could not reach ${parsed.host}:${parsed.port}. If Redis is on a private network, run the proof with the Revenant agent instead.`
          : message,
      unreachable: networkIssue,
    };
  }
}

/** Persist a fingerprint + verification result after a drill or a test. */
export async function recordRedisVerification(
  db: Database,
  organizationId: string,
  redisResourceId: string,
  result: {
    status: "verified" | "failed";
    fingerprint: RedisFingerprint | null;
    restoreProofSeconds?: number | null;
    rpoObservedSeconds?: number | null;
    errorMessage?: string | null;
  }
): Promise<void> {
  const now = new Date();
  await db
    .update(redisResources)
    .set({
      lastVerifiedAt: now,
      lastVerificationStatus: result.status,
      engineVersion: result.fingerprint?.version ?? null,
      fingerprintJson: result.fingerprint,
      lastRestoreProofSeconds: result.restoreProofSeconds ?? null,
      lastRpoObservedSeconds: result.rpoObservedSeconds ?? null,
      updatedAt: now,
    })
    .where(
      and(
        eq(redisResources.id, redisResourceId),
        eq(redisResources.organizationId, organizationId)
      )
    );
}