/**
 * Redis recovery — Revenant's Redis provider.
 *
 * POSITIONING (read before changing anything here)
 * ─────────────────────────────────────────────────
 * Revenant does NOT become a Redis backup vendor.
 * The value is *proof*, not storage:
 *
 *   1. Customer pastes a Redis URL  → we connect and fingerprint it.
 *   2. The agent takes a BGSAVE, copies the RDB to a scratch dir on the
 *      customer's own host, boots a throwaway redis-server on that copy,
 *      and runs checks against the RESTORED instance.
 *   3. Snapshot retention is OPT-IN. If the customer enables it, the RDB is
 *      stored as an artifact with a MANDATORY TTL that we enforce server-side.
 *
 * Bytes never live in the control-plane Postgres. Only metadata does.
 * See docs/REDIS_PROVIDER.md for the full reasoning.
 */

/** Lifecycle of a Redis snapshot artifact (opt-in storage only). */
export type RedisSnapshotStatus =
  | "capturing"
  | "stored"
  | "expired"
  | "deleted"
  | "failed";

export type RedisVerificationStatus = "verified" | "failed" | "never" | "pending";

/** Which restore proof produced a fingerprint. */
export type RedisFingerprintSource = "live" | "restored_rdb";

/**
 * Check types this provider emits. Mirrors the Go CLI check names.
 * All are read-only except redis_restore_proof, which is driven by the agent.
 */
export const REDIS_CHECK_TYPES = [
  "redis_ping",
  "redis_dbsize",
  "redis_keyspace",
  "redis_ttl_distribution",
  "redis_config",
  "redis_value_digest",
  "redis_restore_proof",
] as const;

export type RedisCheckType = (typeof REDIS_CHECK_TYPES)[number];

/** Outcome of one Redis check, mirrored into job_results. */
export interface RedisCheckResult {
  name: string;
  type: RedisCheckType;
  status: "pass" | "fail" | "skip";
  message: string;
  durationMs: number;
}

/**
 * Metadata fingerprint of a Redis instance.
 * MUST NOT contain raw values, raw keys, or secrets — digests only.
 */
export interface RedisFingerprint {
  source: RedisFingerprintSource;
  /** redis_version from INFO server */
  version: string | null;
  mode: string | null;
  /** INFO keyspace — db0:keys / expires */
  keyspace: Record<string, { keys: number; expires: number; avgTtl: number | null }>;
  totalKeys: number;
  totalExpires: number;
  usedMemoryBytes: number | null;
  maxmemoryBytes: number | null;
  maxmemoryPolicy: string | null;
  /** "SET" / "NOT SET" — the actual requirepass value is NEVER stored */
  requirepass: "SET" | "NOT SET";
  appendOnly: "yes" | "no" | null;
  /** CONFIG GET save, e.g. "3600 1 300 100" — raw string, no secrets */
  savePolicy: string | null;
  /**
   * SHA-256 over sampled key digests, sorted. Stable across runs when the
   * keyspace is unchanged. This is what makes drift detection cheap —
   * we never store a single raw key.
   */
  sampleDigest: string | null;
  sampledKeys: number;
  capturedAt: string;
}

/** Drift severity for Redis, aligned with the platform-wide drift model. */
export type RedisDriftChangeType =
  | "version_changed"
  | "keyspace_shrank"
  | "memory_pressure"
  | "maxmemory_policy_changed"
  | "appendonly_changed"
  | "requirepass_removed"
  | "restored_mismatch"
  | "rdb_stale";

export interface RedisDriftEvent {
  changeType: RedisDriftChangeType;
  severity: "stable" | "minor_drift" | "recovery_at_risk" | "recovery_invalidated";
  description: string;
}

/** Public Redis resource shape — never includes the password or full URL. */
export interface RedisResource {
  id: string;
  name: string;
  host: string;
  port: number;
  dbIndex: number;
  username: string | null;
  tls: boolean;
  engineVersion: string | null;
  /** Opt-in: store RDB artifacts in Revenant-managed storage */
  snapshotEnabled: boolean;
  /** MANDATORY TTL in hours — always set when snapshotEnabled is true */
  snapshotRetentionHours: number | null;
  /** Optional link to the Postgres workflow this cache belongs to */
  databaseId: string | null;
  hasCredentials: boolean;
  lastVerifiedAt: string | null;
  lastVerificationStatus: RedisVerificationStatus;
  lastRestoreProofSeconds: number | null;
  fingerprint: RedisFingerprint | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateRedisResourceRequest {
  name: string;
  /** redis://[:password]@host:port/db or rediss://... — stored encrypted */
  url: string;
  databaseId?: string | null;
  snapshotEnabled?: boolean;
  snapshotRetentionHours?: number | null;
}

export interface UpdateRedisResourceRequest {
  name?: string;
  url?: string;
  snapshotEnabled?: boolean;
  snapshotRetentionHours?: number | null;
  databaseId?: string | null;
}

export interface RedisSnapshotResource {
  id: string;
  redisResourceId: string;
  status: RedisSnapshotStatus;
  byteSize: number | null;
  checksumSha256: string | null;
  /** Opaque storage key. Never a public URL. */
  storageKey: string | null;
  /** Redis metadata captured at snapshot time (digests only) */
  metadata: RedisFingerprint | null;
  createdAt: string;
  /** TTL deadline — enforced by the API sweeper, not by the storage layer alone */
  expiresAt: string | null;
  deletedAt: string | null;
  lastVerifiedAt: string | null;
  lastVerificationStatus: RedisVerificationStatus;
}

/** Result of the agent's restore proof — the whole point of the product. */
export interface RedisRestoreProof {
  /** Throwaway container actually booted from the RDB */
  restored: boolean;
  /** Key count in the RESTORED instance (not the live one) */
  restoredKeyCount: number;
  /** Key count in the live instance at BGSAVE time */
  sourceKeyCount: number;
  /** Bytes of RDB copied to the scratch dir */
  rdbBytes: number;
  /** rdb_last_bgsave_status from INFO persistence on the SOURCE */
  rdbLastBgsaveStatus: string | null;
  /** Seconds since the source's last successful save — drives RPO */
  rpoObservedSeconds: number | null;
  /** Seconds from BGSAVE start to restored instance answering PING */
  restoreSeconds: number | null;
  checks: RedisCheckResult[];
  message: string;
}

/** Keys we sample for digest. Raw values never leave the agent. */
export const REDIS_DIGEST_SAMPLE_SIZE = 25;

/** CONFIG keys safe to record verbatim (no secrets). */
export const REDIS_SAFE_CONFIG_KEYS = [
  "maxmemory",
  "maxmemory-policy",
  "appendonly",
  "appendfsync",
  "save",
  "dbfilename",
  "dir",
] as const;

/**
 * CONFIG keys that may contain a secret — record only whether they are set.
 * `requirepass` and `masterauth` are the two that matter.
 */
export const REDIS_SECRET_CONFIG_KEYS = ["requirepass", "masterauth"] as const;

/** TTL buckets reported by the ttl_distribution check (seconds). */
export const REDIS_TTL_BUCKETS = [
  { label: "no_expiry", min: -1, max: -1 },
  { label: "lt_1m", min: 0, max: 60 },
  { label: "lt_1h", min: 60, max: 3600 },
  { label: "lt_1d", min: 3600, max: 86400 },
  { label: "gt_1d", min: 86400, max: Number.MAX_SAFE_INTEGER },
] as const;

/**
 * Plan ceilings for opt-in snapshot storage. The API clamps a customer
 * request down to the plan max — it never accepts a request above it.
 * TTL is always mandatory; null means "use the plan default", not "forever".
 */
export const REDIS_MIN_SNAPSHOT_RETENTION_HOURS = 1;
export const REDIS_MAX_SNAPSHOT_RETENTION_HOURS = 24 * 365;

/** Default TTL when a customer enables snapshots without naming one. */
export const REDIS_DEFAULT_SNAPSHOT_RETENTION_HOURS = 24;

/** Parse a redis:// or rediss:// URL into its parts. Never logs the password. */
export function parseRedisUrl(raw: string): {
  host: string;
  port: number;
  username: string | null;
  password: string | null;
  dbIndex: number;
  tls: boolean;
} | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "redis:" && url.protocol !== "rediss:") return null;
  if (!url.hostname) return null;

  const dbPart = url.pathname.replace(/^\//, "");
  const parsedDb = dbPart === "" ? 0 : Number.parseInt(dbPart, 10);

  return {
    host: url.hostname,
    port: url.port ? Number.parseInt(url.port, 10) : 6379,
    username: url.username ? decodeURIComponent(url.username) : null,
    password: url.password ? decodeURIComponent(url.password) : null,
    dbIndex: Number.isFinite(parsedDb) && parsedDb >= 0 ? parsedDb : 0,
    tls: url.protocol === "rediss:",
  };
}

/** Mask a URL for logs and API responses — password and username removed. */
export function redactRedisUrl(raw: string): string {
  const parsed = parseRedisUrl(raw);
  if (!parsed) return "redis://<invalid>";
  const auth = parsed.username
    ? `${parsed.username}:***@`
    : parsed.password
      ? "***@"
      : "";
  return `${parsed.tls ? "rediss" : "redis"}://${auth}${parsed.host}:${parsed.port}/${parsed.dbIndex}`;
}