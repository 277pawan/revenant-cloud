ALTER TABLE "redis_proofs"
  ADD COLUMN IF NOT EXISTS "checks_json" jsonb;
