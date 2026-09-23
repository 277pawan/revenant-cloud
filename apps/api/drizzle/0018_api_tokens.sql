CREATE TABLE "api_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "created_by_user_id" uuid NOT NULL,
  "name" varchar(255) NOT NULL,
  "token_prefix" varchar(20) NOT NULL,
  "token_hash" varchar(64) NOT NULL,
  "role" varchar(50) NOT NULL,
  "last_used_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;

CREATE UNIQUE INDEX "api_tokens_token_hash_idx" ON "api_tokens" USING btree ("token_hash");
CREATE INDEX "api_tokens_organization_id_idx" ON "api_tokens" USING btree ("organization_id");
