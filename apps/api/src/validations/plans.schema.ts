import { z } from "zod";

export const upsertValidationPlanSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  yamlText: z
    .string()
    .min(1, "YAML is required")
    .max(200_000, "YAML is too large"),
});

export const databaseIdParamSchema = z.object({
  databaseId: z.string().uuid(),
});

export type UpsertValidationPlanInput = z.infer<typeof upsertValidationPlanSchema>;
