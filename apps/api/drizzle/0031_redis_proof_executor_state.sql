-- Redis proofs: executor state, so a run is never silently stuck.
--
-- WHY THIS MIGRATION EXISTS
--
-- Redis restore proofs were created as `pending` rows and could ONLY be
-- claimed by a self-hosted agent. In a deployment without an agent the row
-- sat in `pending` until a sweeper flipped it to `error` 30 minutes later
-- with "No Redis proof worker claimed this run" — the customer had no way
-- to see who was supposed to run it, how many times it was tried, or why
-- the last attempt was handed back.
--
-- These columns make the queue observable and routable:
--
--   attempts       — how many times the proof has been claimed. A proof that
--                    keeps coming back is a proof nobody could reach.
--   claimed_by     — which executor took it ("cloud:<instance>" or
--                    "agent:<runnerId>"). Answers "who is running this?".
--   last_error     — why the last attempt was released back to the queue.
--   last_error_kind— machine-readable class of the above:
--                    unreachable | auth | failed. "unreachable" means the
--                    executor had no network route, which is NOT proof that
--                    the backup is broken — the run is re-routed to an
--                    executor inside the customer's network instead.
--   next_attempt_at— earliest time the cloud worker may retry. Agents ignore
--                    it, because an agent on the customer's network can
--                    usually reach what the cloud cannot.
--
-- All five are nullable/defaulted, so this migration is safe to run against
-- a live table with proofs already in flight.

ALTER TABLE "redis_proofs"
  ADD COLUMN IF NOT EXISTS "attempts" integer NOT NULL DEFAULT 0;

ALTER TABLE "redis_proofs"
  ADD COLUMN IF NOT EXISTS "claimed_by" varchar(120);

ALTER TABLE "redis_proofs"
  ADD COLUMN IF NOT EXISTS "last_error" text;

ALTER TABLE "redis_proofs"
  ADD COLUMN IF NOT EXISTS "last_error_kind" varchar(20);

ALTER TABLE "redis_proofs"
  ADD COLUMN IF NOT EXISTS "next_attempt_at" timestamp with time zone;

-- The cloud worker claims with `next_attempt_at <= now()` in the predicate.
-- Without this index the claim degrades to a filter on top of the pending
-- scan. The index is partial, so it stays bounded by in-flight work rather
-- than by history — same rule as the other proof indexes.
CREATE INDEX IF NOT EXISTS "redis_proofs_retry_idx"
  ON "redis_proofs" ("next_attempt_at")
  WHERE "status" = 'pending';
