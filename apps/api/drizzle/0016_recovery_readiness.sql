CREATE TABLE IF NOT EXISTS "recovery_contracts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "database_id" uuid NOT NULL REFERENCES "databases"("id") ON DELETE cascade,
  "version" integer NOT NULL DEFAULT 1,
  "definition_json" jsonb NOT NULL,
  "rto_seconds" integer,
  "rpo_seconds" integer,
  "status" varchar(50) NOT NULL DEFAULT 'active',
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "recovery_contracts_database_id_idx" ON "recovery_contracts" ("database_id");

CREATE TABLE IF NOT EXISTS "recovery_fingerprints" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "database_id" uuid NOT NULL REFERENCES "databases"("id") ON DELETE cascade,
  "job_id" uuid REFERENCES "jobs"("id") ON DELETE set null,
  "fingerprint_json" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "recovery_fingerprints_database_id_idx" ON "recovery_fingerprints" ("database_id", "created_at" DESC);

CREATE TABLE IF NOT EXISTS "recovery_drift_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "database_id" uuid NOT NULL REFERENCES "databases"("id") ON DELETE cascade,
  "from_fingerprint_id" uuid REFERENCES "recovery_fingerprints"("id") ON DELETE set null,
  "to_fingerprint_id" uuid REFERENCES "recovery_fingerprints"("id") ON DELETE set null,
  "severity" varchar(50) NOT NULL,
  "change_type" varchar(100) NOT NULL,
  "description" text NOT NULL,
  "status" varchar(50) NOT NULL DEFAULT 'open',
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "recovery_drift_events_database_id_idx" ON "recovery_drift_events" ("database_id", "created_at" DESC);
