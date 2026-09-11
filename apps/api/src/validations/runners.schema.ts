import { z } from "zod";

export const createRunnerSchema = z.object({
  name: z.string().min(2).max(255),
  kind: z.enum(["agent", "ci"]).default("agent"),
});

export const runnerIdParamSchema = z.object({
  id: z.string().uuid(),
});

export type CreateRunnerInput = z.infer<typeof createRunnerSchema>;
