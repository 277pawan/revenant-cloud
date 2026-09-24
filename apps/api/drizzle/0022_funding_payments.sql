CREATE TABLE IF NOT EXISTS "funding_payments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "razorpay_order_id" varchar(64) NOT NULL,
  "razorpay_payment_id" varchar(64),
  "amount_paise" integer NOT NULL,
  "currency" varchar(8) DEFAULT 'INR' NOT NULL,
  "status" varchar(32) DEFAULT 'created' NOT NULL,
  "name" varchar(255) NOT NULL,
  "email" varchar(255) NOT NULL,
  "note" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "paid_at" timestamp with time zone
);

CREATE UNIQUE INDEX IF NOT EXISTS "funding_payments_razorpay_order_id_idx"
  ON "funding_payments" ("razorpay_order_id");

CREATE UNIQUE INDEX IF NOT EXISTS "funding_payments_razorpay_payment_id_idx"
  ON "funding_payments" ("razorpay_payment_id")
  WHERE "razorpay_payment_id" IS NOT NULL;
