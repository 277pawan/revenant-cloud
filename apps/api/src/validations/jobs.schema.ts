import { z } from "zod";
import { paginationQuerySchema } from "./pagination.schema.js";

export const listJobsQuerySchema = paginationQuerySchema.extend({
  databaseId: z.string().uuid().optional(),
  search: z.string().trim().max(255).optional(),
});

export const createJobSchema = z.object({
  databaseId: z.string().uuid(),
  drillKind: z.enum(["verify", "full"]).default("full"),
  recoveryPointId: z.string().uuid().optional(),
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

export const jobProgressSchema = z.object({
  stage: z.enum([
    "runner_starting",
    "resolving_cli",
    "checking_source",
    "creating_snapshot",
    "waiting_for_snapshot",
    "selecting_snapshot",
    "restoring_sandbox",
    "waiting_for_sandbox",
    "connecting_sandbox",
    "running_checks",
    "cleaning_sandbox",
    "reaping_sandboxes",
  ]),
  message: z.string().trim().min(1).max(255),
  checks: z.array(z.object({
    checkName: z.string().min(1).max(255),
    checkType: z.string().min(1).max(100),
    status: z.enum(["pass", "fail", "skip"]),
    message: z.string().max(500).nullable(),
  })).max(100).optional(),
});

export type ListJobsQueryInput = z.infer<typeof listJobsQuerySchema>;
export type CreateJobInput = z.infer<typeof createJobSchema>;
export type CompleteJobInput = z.infer<typeof completeJobSchema>;
export type JobProgressInput = z.infer<typeof jobProgressSchema>;
