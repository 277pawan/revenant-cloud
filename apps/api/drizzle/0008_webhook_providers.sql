ALTER TABLE "webhook_endpoints" ADD COLUMN "provider" varchar(50) DEFAULT 'http' NOT NULL;
--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD COLUMN "config" text DEFAULT '{}' NOT NULL;
--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ALTER COLUMN "url" DROP NOT NULL;
--> statement-breakpoint
UPDATE "webhook_endpoints" SET "config" = json_build_object('url', "url")::text WHERE "url" IS NOT NULL AND ("config" = '{}' OR "config" IS NULL);
