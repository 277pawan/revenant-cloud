import { z } from "zod";

export const FUNDING_MIN_INR = 1;
export const FUNDING_MAX_INR = 500_000;

export const fundingCreateOrderSchema = z.object({
  name: z.string().trim().min(1).max(255),
  email: z.string().trim().email().max(255),
  amountInr: z
    .number()
    .int()
    .min(FUNDING_MIN_INR, `Minimum amount is ₹${FUNDING_MIN_INR}`)
    .max(FUNDING_MAX_INR, `Maximum amount is ₹${FUNDING_MAX_INR.toLocaleString("en-IN")}`),
  note: z.string().trim().max(2000).optional(),
});

export const fundingVerifyPaymentSchema = z.object({
  razorpay_order_id: z.string().min(1),
  razorpay_payment_id: z.string().min(1),
  razorpay_signature: z.string().min(1),
});

export type FundingCreateOrderInput = z.infer<typeof fundingCreateOrderSchema>;
export type FundingVerifyPaymentInput = z.infer<typeof fundingVerifyPaymentSchema>;
