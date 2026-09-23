-- Phase 7: recovery challenges
CREATE TABLE IF NOT EXISTS "recovery_challenges" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "database_id" uuid NOT NULL REFERENCES "databases"("id") ON DELETE cascade,
  "name" varchar(255) NOT NULL,
  "strategy" varchar(50) NOT NULL DEFAULT 'latest',
  "days_ago" integer NOT NULL DEFAULT 0,
  "enabled" varchar(10) NOT NULL DEFAULT 'true',
  "last_run_at" timestamp with time zone,
  "last_job_id" uuid REFERENCES "jobs"("id") ON DELETE set null,
  "last_status" varchar(50),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "recovery_challenges_database_id_idx"
  ON "recovery_challenges" ("database_id", "created_at" DESC);

-- Phase 8: historical readiness snapshots
CREATE TABLE IF NOT EXISTS "readiness_snapshots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "database_id" uuid NOT NULL REFERENCES "databases"("id") ON DELETE cascade,
  "job_id" uuid NOT NULL REFERENCES "jobs"("id") ON DELETE cascade,
  "score" integer NOT NULL,
  "status" varchar(50) NOT NULL,
  "rto_actual_seconds" integer,
  "rpo_observed_seconds" integer,
  "recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "readiness_snapshots_database_id_idx"
  ON "readiness_snapshots" ("database_id", "recorded_at" DESC);

-- Job metadata for challenge runs and correlation
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "metadata_json" jsonb;
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "correlation_id" varchar(64);
