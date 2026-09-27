-- Recovery Points: metadata + verification history around customer AWS snapshots.
-- Revenant does NOT store database backup data.

CREATE TABLE IF NOT EXISTS "recovery_points" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "database_id" uuid NOT NULL REFERENCES "databases"("id") ON DELETE cascade,
  "provider" varchar(50) NOT NULL DEFAULT 'aws-rds',
  "region" varchar(50),
  "source_db_identifier" varchar(255),
  "snapshot_identifier" varchar(255) NOT NULL,
  "snapshot_arn" varchar(512),
  "engine" varchar(50),
  "engine_version" varchar(50),
  "snapshot_created_at" timestamp with time zone,
  "snapshot_origin" varchar(50) NOT NULL DEFAULT 'unknown',
  "status" varchar(50) NOT NULL DEFAULT 'active',
  "last_verified_at" timestamp with time zone,
  "last_verification_status" varchar(50) NOT NULL DEFAULT 'never',
  "last_verification_job_id" uuid REFERENCES "jobs"("id") ON DELETE set null,
  "last_rto_seconds" integer,
  "last_rpo_observed_seconds" integer,
  "validation_plan_version" integer,
  "created_by_user_id" uuid REFERENCES "users"("id") ON DELETE set null,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "recovery_points_database_id_idx"
  ON "recovery_points" ("database_id", "last_verified_at" DESC NULLS LAST);

CREATE UNIQUE INDEX IF NOT EXISTS "recovery_points_org_snapshot_uidx"
  ON "recovery_points" ("organization_id", "database_id", "snapshot_identifier");

CREATE TABLE IF NOT EXISTS "recovery_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "recovery_point_id" uuid NOT NULL REFERENCES "recovery_points"("id") ON DELETE cascade,
  "job_id" uuid REFERENCES "jobs"("id") ON DELETE set null,
  "run_type" varchar(50) NOT NULL,
  "status" varchar(50) NOT NULL,
  "cleanup_status" varchar(50),
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "restore_started_at" timestamp with time zone,
  "restore_completed_at" timestamp with time zone,
  "rto_seconds" integer,
  "error_message" text,
  "metadata_json" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "recovery_runs_point_id_idx"
  ON "recovery_runs" ("recovery_point_id", "created_at" DESC);

CREATE TABLE IF NOT EXISTS "recovery_instances" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "recovery_run_id" uuid NOT NULL REFERENCES "recovery_runs"("id") ON DELETE cascade,
  "aws_db_instance_identifier" varchar(255) NOT NULL,
  "endpoint" varchar(512),
  "port" integer,
  "region" varchar(50),
  "instance_class" varchar(50),
  "temporary" varchar(10) NOT NULL DEFAULT 'true',
  "status" varchar(50) NOT NULL DEFAULT 'creating',
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone
);

CREATE INDEX IF NOT EXISTS "recovery_instances_run_id_idx"
  ON "recovery_instances" ("recovery_run_id");
