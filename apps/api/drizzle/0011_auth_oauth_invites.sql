-- OAuth identities + invite tokens (SSO + team onboarding architecture)
-- password_hash becomes optional for OAuth-only users

ALTER TABLE "users" ALTER COLUMN "password_hash" DROP NOT NULL;

CREATE TABLE IF NOT EXISTS "user_auth_providers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "provider" varchar(50) NOT NULL,
  "provider_subject" varchar(255) NOT NULL,
  "email" varchar(255),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "user_auth_providers_provider_subject_unique" UNIQUE("provider", "provider_subject")
);

CREATE INDEX IF NOT EXISTS "user_auth_providers_user_id_idx" ON "user_auth_providers" ("user_id");

CREATE TABLE IF NOT EXISTS "organization_invites" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "email" varchar(255) NOT NULL,
  "role" varchar(50) NOT NULL DEFAULT 'executor',
  "token_hash" text NOT NULL,
  "invited_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "accepted_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "organization_invites_org_email_unique" UNIQUE("organization_id", "email")
);

CREATE INDEX IF NOT EXISTS "organization_invites_token_hash_idx" ON "organization_invites" ("token_hash");
