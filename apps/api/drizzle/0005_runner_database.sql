ALTER TABLE "runners" ADD COLUMN "database_id" uuid;
--> statement-breakpoint
ALTER TABLE "runners" ADD CONSTRAINT "runners_database_id_databases_id_fk" FOREIGN KEY ("database_id") REFERENCES "public"."databases"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "runners_org_database_active_idx" ON "runners" ("organization_id", "database_id") WHERE "revoked_at" IS NULL AND "database_id" IS NOT NULL;
