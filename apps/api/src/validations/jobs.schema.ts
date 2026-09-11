import { z } from "zod";

export const createJobSchema = z.object({
  databaseId: z.string().uuid(),
});

export const jobIdParamSchema = z.object({
  id: z.string().uuid(),
});

export const completeJobSchema = z.object({
  status: z.enum(["pass", "fail", "error"]),
  errorMessage: z.string().max(4000).optional(),
  rtoSeconds: z.number().int().min(0).optional(),
  /** Optional override — normally set on claim from runner kind */
  executionMode: z.enum(["stub", "agent", "ci"]).optional(),
  results: z
    .array(
      z.object({
        checkName: z.string().min(1).max(255),
        checkType: z.string().min(1).max(100),
        status: z.enum(["pass", "fail", "skip"]),
        message: z.string().max(4000).optional(),
        durationMs: z.number().int().min(0).optional(),
      })
    )
    .default([]),
});

export type CreateJobInput = z.infer<typeof createJobSchema>;
export type CompleteJobInput = z.infer<typeof completeJobSchema>;
