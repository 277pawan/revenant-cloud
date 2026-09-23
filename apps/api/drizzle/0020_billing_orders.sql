CREATE TABLE IF NOT EXISTS "billing_orders" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "razorpay_order_id" varchar(64) NOT NULL,
  "amount_paise" integer NOT NULL,
  "currency" varchar(8) NOT NULL DEFAULT 'INR',
  "plan" varchar(32) NOT NULL,
  "purpose" varchar(64) NOT NULL DEFAULT 'autopay_setup',
  "status" varchar(32) NOT NULL DEFAULT 'created',
  "razorpay_payment_id" varchar(64),
  "created_by_user_id" uuid REFERENCES "users"("id") ON DELETE set null,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "paid_at" timestamp with time zone
);

CREATE UNIQUE INDEX IF NOT EXISTS "billing_orders_razorpay_order_id_idx"
  ON "billing_orders" ("razorpay_order_id");

CREATE UNIQUE INDEX IF NOT EXISTS "billing_orders_payment_id_idx"
  ON "billing_orders" ("razorpay_payment_id")
  WHERE "razorpay_payment_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "billing_orders_org_status_idx"
  ON "billing_orders" ("organization_id", "status", "purpose");
