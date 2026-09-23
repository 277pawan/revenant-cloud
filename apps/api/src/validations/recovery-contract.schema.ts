import { z } from "zod";

const durationPattern = /^\d+(\.\d+)?(ms|s|m|h|d)$/i;

const optionalUrl = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().url().optional()
);

export const recoveryContractRequiredSchema = z.object({
  database: z.boolean().optional(),
  schema: z.boolean().optional(),
  critical_queries: z.boolean().optional(),
  api: z.boolean().optional(),
  healthcheck: z.boolean().optional(),
});

export const recoveryContractDefinitionSchema = z.object({
  version: z.string().min(1),
  recovery: z.object({
    rto: z.string().regex(durationPattern, "Invalid RTO duration (e.g. 15m)"),
    rpo: z.string().regex(durationPattern, "Invalid RPO duration (e.g. 5m)"),
    required: recoveryContractRequiredSchema.default({}),
    dependencies: z.array(z.string()).optional(),
    application: z
      .object({
        healthcheck: optionalUrl,
        endpoints: z
          .array(
            z.object({
              name: z.string(),
              method: z.string(),
              path: z.string(),
              expect_status: z.number().int().optional(),
            })
          )
          .optional(),
      })
      .optional(),
    critical_queries: z
      .array(z.object({ name: z.string(), sql: z.string() }))
      .optional(),
    checks: z.array(z.string()).optional(),
    maxVerificationAgeHours: z.number().int().positive().optional(),
    max_verification_age_hours: z.number().int().positive().optional(),
  }),
});

export const upsertRecoveryContractSchema = z
  .object({
    yamlText: z.string().min(1).optional(),
    definition: recoveryContractDefinitionSchema.optional(),
  })
  .superRefine((data, ctx) => {
    if (!data.yamlText && !data.definition) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "yamlText or definition is required",
        path: ["yamlText"],
      });
    }
  });

export type UpsertRecoveryContractInput = z.infer<typeof upsertRecoveryContractSchema>;
