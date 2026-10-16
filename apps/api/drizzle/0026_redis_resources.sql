-- Redis provider: opt-in, TTL-bounded snapshot artifacts + restore-proof metadata.
--
-- STORAGE RULE (do not violate): Redis BYTES never go into this database.
-- This control plane stores METADATA ONLY — keyspace counts, config flags,
-- SHA-256 digests of sampled keys, sizes and checksums. RDB artifacts live
-- in the artifact store behind the ArtifactStore interface (see
-- src/lib/artifact-store.ts) and are referenced by storage_key.
--
-- Samples are recorded as `captured` (agent is running a BGSAVE) or
-- `verified` (agent uploaded an artifact). `failed` means the BGSAVE or
-- upload errored; the agent reports the reason and nothing is stored.

CREATE TABLE IF NOT EXISTS "redis_resources" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  -- Optional link to the Postgres workflow whose recovery system this cache
  -- belongs to. Nullable on purpose: Redis can be verified standalone.
  "database_id" uuid REFERENCES "databases"("id") ON DELETE set null,
  "name" varchar(255) NOT NULL,
  "host" varchar(255) NOT NULL,
  "port" integer NOT NULL DEFAULT 6379,
  "db_index" integer NOT NULL DEFAULT 0,
  "username" varchar(255),
  "tls" varchar(10) NOT NULL DEFAULT 'false',
  "engine_version" varchar(50),
  -- Opt-in. When false, Revenant verifies but stores nothing.
  "snapshot_enabled" varchar(10) NOT NULL DEFAULT 'false',
  -- MANDATORY TTL in hours. Must be > 0 whenever snapshot_enabled is true.
  "snapshot_retention_hours" integer,
  "last_verified_at" timestamp with time zone,
  "last_verification_status" varchar(50) NOT NULL DEFAULT 'never',
  "last_restore_proof_seconds" integer,
  "last_rpo_observed_seconds" integer,
  "fingerprint_json" jsonb,
  "created_by_user_id" uuid REFERENCES "users"("id") ON DELETE set null,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "redis_resources_org_idx"
  ON "redis_resources" ("organization_id", "created_at" DESC);

CREATE UNIQUE INDEX IF NOT EXISTS "redis_resources_org_name_uidx"
  ON "redis_resources" ("organization_id", "name");

CREATE INDEX IF NOT EXISTS "redis_resources_database_id_idx"
  ON "redis_resources" ("database_id");

-- Encrypted Redis URL (redis:// or rediss://) — AES-256-GCM, 1:1 per resource.
-- Plaintext never stored, never returned by any endpoint.
CREATE TABLE IF NOT EXISTS "redis_credentials" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "redis_resource_id" uuid NOT NULL REFERENCES "redis_resources"("id") ON DELETE cascade,
  "ciphertext" text NOT NULL,
  "iv" text NOT NULL,
  "auth_tag" text NOT NULL,
  "key_version" integer NOT NULL DEFAULT 1,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "redis_credentials_resource_id_uidx"
  ON "redis_credentials" ("redis_resource_id");

-- Opt-in snapshot artifacts. Every row MUST carry expires_at; the sweeper
-- (services/redis-snapshots.service.ts) hard-deletes past it. A row with
-- NULL expires_at while status = 'stored' is a bug — treat as expired.
CREATE TABLE IF NOT EXISTS "redis_snapshots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "redis_resource_id" uuid NOT NULL REFERENCES "redis_resources"("id") ON DELETE cascade,
  "job_id" uuid REFERENCES "jobs"("id") ON DELETE set null,
  -- capturing | stored | expired | deleted | failed
  "status" varchar(50) NOT NULL DEFAULT 'capturing',
  "byte_size" bigint,
  "checksum_sha256" varchar(64),
  -- Opaque key into the ArtifactStore. Never a public URL.
  "storage_key" varchar(512),
  -- Redis metadata at snapshot time. Digests only, never raw values.
  "metadata_json" jsonb,
  "expires_at" timestamp with time zone NOT NULL,
  "deleted_at" timestamp with time zone,
  "last_verified_at" timestamp with time zone,
  "last_verification_status" varchar(50) NOT NULL DEFAULT 'never',
  "error_message" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- Sweeper's hot path: find expired-but-not-yet-deleted artifacts.
CREATE INDEX IF NOT EXISTS "redis_snapshots_sweep_idx"
  ON "redis_snapshots" ("expires_at")
  WHERE "deleted_at" IS NULL;

CREATE INDEX IF NOT EXISTS "redis_snapshots_resource_idx"
  ON "redis_snapshots" ("redis_resource_id", "created_at" DESC);

CREATE UNIQUE INDEX IF NOT EXISTS "redis_snapshots_org_checksum_uidx"
  ON "redis_snapshots" ("organization_id", "checksum_sha256")
  WHERE "checksum_sha256" IS NOT NULL;

-- Restore-proof ledger.
--
-- One row per proof attempt, whether or not the customer enabled snapshot
-- storage. This is what the plan quota counts (redisRestoreProofsPerMonth)
-- and what the Redis RTO trend reads. Kept separate from redis_snapshots so
-- that "we ran a proof" and "we kept bytes" never get conflated.
--
-- NOTE: the `jobs` table requires a non-null database_id, and a Redis
-- resource may legitimately have no linked Postgres workflow. That is why
-- proofs get their own ledger instead of riding on jobs.
CREATE TABLE IF NOT EXISTS "redis_proofs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "redis_resource_id" uuid NOT NULL REFERENCES "redis_resources"("id") ON DELETE cascade,
  "snapshot_id" uuid REFERENCES "redis_snapshots"("id") ON DELETE set null,
  "triggered_by_user_id" uuid REFERENCES "users"("id") ON DELETE set null,
  -- pending | running | pass | fail | error
  "status" varchar(50) NOT NULL DEFAULT 'pending',
  -- Did the throwaway redis-server actually boot from the RDB? The whole point.
  "restored" varchar(10),
  "source_key_count" integer,
  "restored_key_count" integer,
  "rdb_bytes" bigint,
  "restore_seconds" integer,
  "rpo_observed_seconds" integer,
  "rdb_last_bgsave_status" varchar(50),
  "error_message" text,
  "metadata_json" jsonb,
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "redis_proofs_quota_idx"
  ON "redis_proofs" ("organization_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "redis_proofs_resource_idx"
  ON "redis_proofs" ("redis_resource_id", "created_at" DESC);

-- Guard the TTL invariant at the database level. snapshot_enabled without a
-- retention window would mean an unbounded artifact, so refuse the write.
ALTER TABLE "redis_resources"
  ADD CONSTRAINT "redis_resources_snapshot_ttl_required"
  CHECK (
    (snapshot_enabled = 'false' AND (snapshot_retention_hours IS NULL OR snapshot_retention_hours > 0))
    OR (snapshot_enabled = 'true' AND snapshot_retention_hours > 0)
  );

ALTER TABLE "redis_resources"
  ADD CONSTRAINT "redis_resources_snapshot_ttl_positive"
  CHECK (snapshot_retention_hours IS NULL OR snapshot_retention_hours > 0);