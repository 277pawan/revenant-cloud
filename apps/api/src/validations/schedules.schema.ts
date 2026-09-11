import { z } from "zod";

export const createScheduleSchema = z.object({
  databaseId: z.string().uuid(),
  name: z.string().min(1).max(255),
  cronExpression: z.string().min(9).max(100),
  timezone: z.string().min(1).max(64).default("UTC"),
  enabled: z.boolean().default(true),
});

export const updateScheduleSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  cronExpression: z.string().min(9).max(100).optional(),
  timezone: z.string().min(1).max(64).optional(),
  enabled: z.boolean().optional(),
});

export const scheduleIdParamSchema = z.object({
  id: z.string().uuid(),
});
