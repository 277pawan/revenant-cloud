-- Allow multiple evidence artifacts per job (e.g. json report + recovery passport).
DROP INDEX IF EXISTS "evidence_artifacts_job_id_idx";
CREATE UNIQUE INDEX "evidence_artifacts_job_id_kind_idx" ON "evidence_artifacts" USING btree ("job_id", "kind");
