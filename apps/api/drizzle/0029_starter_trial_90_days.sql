UPDATE "organizations"
SET "trial_ends_at" = GREATEST("trial_ends_at", "created_at" + interval '90 days')
WHERE "subscription_status" = 'trialing'
  AND "plan" = 'starter'
  AND "trial_ends_at" > NOW()
  AND "razorpay_subscription_id" IS NULL
  AND "razorpay_subscription_status" IS NULL
  AND "trial_ends_at" < "created_at" + interval '90 days';
