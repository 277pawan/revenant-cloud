import { z } from "zod";

export const contactSubmitSchema = z.object({
  type: z.enum(["talk", "coffee"]),
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(255),
  message: z.string().trim().max(5000).optional(),
  /** Funding amount in INR (Buy coffee) */
  amountInr: z.number().int().positive().max(100000).optional(),
});

export type ContactSubmitInput = z.infer<typeof contactSubmitSchema>;
