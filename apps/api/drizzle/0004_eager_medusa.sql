CREATE TABLE "runners" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"kind" varchar(50) DEFAULT 'agent' NOT NULL,
	"token_hash" text NOT NULL,
	"token_prefix" varchar(12) NOT NULL,
	"last_seen_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "execution_mode" varchar(50);--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "claimed_by_runner_id" uuid;--> statement-breakpoint
ALTER TABLE "runners" ADD CONSTRAINT "runners_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;