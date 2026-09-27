import { z } from "zod";

export const selectBillingPlanSchema = z.object({
  plan: z.enum(["starter", "pro"]),
});

export const createBillingOrderSchema = z.object({
  plan: z.enum(["starter", "pro"]).optional(),
});

export type SelectBillingPlanInput = z.infer<typeof selectBillingPlanSchema>;
