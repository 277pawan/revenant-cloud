ALTER TABLE "webhook_endpoints" ADD COLUMN "credential_ciphertext" text;
--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD COLUMN "credential_iv" text;
--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD COLUMN "credential_auth_tag" text;
