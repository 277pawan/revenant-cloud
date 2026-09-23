ALTER TABLE "organizations"
  ADD COLUMN IF NOT EXISTS "razorpay_customer_id" varchar(64),
  ADD COLUMN IF NOT EXISTS "razorpay_subscription_id" varchar(64),
  ADD COLUMN IF NOT EXISTS "razorpay_subscription_status" varchar(32);

CREATE UNIQUE INDEX IF NOT EXISTS "organizations_razorpay_subscription_id_idx"
  ON "organizations" ("razorpay_subscription_id")
  WHERE "razorpay_subscription_id" IS NOT NULL;

ALTER TABLE "billing_orders"
  ADD COLUMN IF NOT EXISTS "razorpay_subscription_id" varchar(64);

ALTER TABLE "billing_orders"
  ALTER COLUMN "razorpay_order_id" DROP NOT NULL;
