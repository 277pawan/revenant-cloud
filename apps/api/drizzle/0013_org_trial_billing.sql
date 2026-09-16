ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "trial_ends_at" timestamp with time zone;
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "subscription_status" varchar(50) NOT NULL DEFAULT 'trialing';

UPDATE "organizations"
SET
  "trial_ends_at" = COALESCE("trial_ends_at", "created_at" + interval '30 days'),
  "subscription_status" = COALESCE(NULLIF("subscription_status", ''), 'trialing')
WHERE "trial_ends_at" IS NULL OR "subscription_status" IS NULL;
