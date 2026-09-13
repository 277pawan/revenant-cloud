ALTER TABLE "databases" ADD COLUMN "recovery_mode" varchar(50) DEFAULT 'direct' NOT NULL;
--> statement-breakpoint
ALTER TABLE "databases" ADD COLUMN "rds_source_identifier" varchar(255);
--> statement-breakpoint
ALTER TABLE "databases" ADD COLUMN "recovery_use_freetier" varchar(10) DEFAULT 'false' NOT NULL;
--> statement-breakpoint
ALTER TABLE "databases" ADD COLUMN "recovery_sandbox_instance_class" varchar(50);
--> statement-breakpoint
CREATE TABLE "database_aws_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"database_id" uuid NOT NULL,
	"ciphertext" text NOT NULL,
	"iv" text NOT NULL,
	"auth_tag" text NOT NULL,
	"key_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "database_aws_credentials" ADD CONSTRAINT "database_aws_credentials_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "database_aws_credentials" ADD CONSTRAINT "database_aws_credentials_database_id_databases_id_fk" FOREIGN KEY ("database_id") REFERENCES "public"."databases"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "database_aws_credentials_database_id_idx" ON "database_aws_credentials" USING btree ("database_id");
