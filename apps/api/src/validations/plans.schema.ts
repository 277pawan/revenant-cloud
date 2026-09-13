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

export const generateValidationYamlSchema = z.object({
  schemaText: z
    .string()
    .min(20, "Schema is too short")
    .max(80_000, "Schema is too large (80KB max)"),
  intent: z.string().max(4000).optional(),
  planName: z.string().min(1).max(80).optional(),
  layers: z.array(z.string().max(40)).max(12).optional(),
});

export type UpsertValidationPlanInput = z.infer<typeof upsertValidationPlanSchema>;
export type GenerateValidationYamlInput = z.infer<typeof generateValidationYamlSchema>;
