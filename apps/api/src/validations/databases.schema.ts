import { z } from "zod";
import { paginationQuerySchema } from "./pagination.schema.js";

export const databasesListQuerySchema = paginationQuerySchema.extend({
  search: z.string().trim().max(255).optional(),
});

export type DatabasesListQueryInput = z.infer<typeof databasesListQuerySchema>;

const recoveryModeSchema = z.enum(["direct", "aws-rds"]);

const awsRecoveryRefine = (
  data: {
    recoveryMode?: string;
    host?: string | null;
    region?: string | null;
    rdsSourceIdentifier?: string | null;
    username?: string | null;
    databaseName?: string | null;
    password?: string | null;
    awsAccessKeyId?: string | null;
    awsSecretAccessKey?: string | null;
  },
  ctx: z.RefinementCtx,
  requireAwsKeys: boolean
) => {
  const mode = data.recoveryMode ?? "direct";
  if (mode === "aws-rds") {
    if (!data.rdsSourceIdentifier?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "RDS instance identifier is required for AWS restore mode",
        path: ["rdsSourceIdentifier"],
      });
    }
    if (!data.region?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "AWS region is required for AWS restore mode",
        path: ["region"],
      });
    }
    if (!data.username?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "RDS master username is required (used as SANDBOX_USER after restore)",
        path: ["username"],
      });
    }
    if (!data.databaseName?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Database name is required (used as SANDBOX_DBNAME after restore)",
        path: ["databaseName"],
      });
    }
    if (requireAwsKeys) {
      if (!data.awsAccessKeyId?.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "AWS access key ID is required for AWS restore mode",
          path: ["awsAccessKeyId"],
        });
      }
      if (!data.awsSecretAccessKey?.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "AWS secret access key is required for AWS restore mode",
          path: ["awsSecretAccessKey"],
        });
      }
    }
  } else if (!data.host?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Host is required for direct connection mode",
      path: ["host"],
    });
  }
};

export const createDatabaseSchema = z
  .object({
    name: z.string().min(1).max(255),
    engine: z.enum(["postgres"]).default("postgres"),
    host: z.string().max(255).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    databaseName: z.string().max(255).optional(),
    username: z.string().max(255).optional(),
    password: z.string().min(1).max(512).optional(),
    sslMode: z.enum(["require", "prefer", "disable"]).optional(),
    region: z.string().max(50).optional(),
    recoveryMode: recoveryModeSchema.default("direct"),
    rdsSourceIdentifier: z.string().max(255).optional(),
    recoveryUseFreetier: z.boolean().optional(),
    recoverySandboxInstanceClass: z.string().max(50).optional(),
    awsAccessKeyId: z.string().max(128).optional(),
    awsSecretAccessKey: z.string().max(128).optional(),
    description: z.string().max(2000).optional(),
  })
  .superRefine((data, ctx) => {
    awsRecoveryRefine(data, ctx, data.recoveryMode === "aws-rds");
    if (data.recoveryMode === "aws-rds" && !data.password?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "RDS master password is required for AWS restore mode",
        path: ["password"],
      });
    }
  });

export const updateDatabaseSchema = z
  .object({
    name: z.string().min(1).max(255).optional(),
    engine: z.enum(["postgres"]).optional(),
    host: z.string().max(255).nullable().optional(),
    port: z.number().int().min(1).max(65535).nullable().optional(),
    databaseName: z.string().max(255).nullable().optional(),
    username: z.string().max(255).nullable().optional(),
    /** omit = unchanged; "" = clear; non-empty = re-encrypt */
    password: z.string().max(512).optional(),
    sslMode: z.enum(["require", "prefer", "disable"]).nullable().optional(),
    region: z.string().max(50).nullable().optional(),
    recoveryMode: recoveryModeSchema.optional(),
    rdsSourceIdentifier: z.string().max(255).nullable().optional(),
    recoveryUseFreetier: z.boolean().optional(),
    recoverySandboxInstanceClass: z.string().max(50).nullable().optional(),
    awsAccessKeyId: z.string().max(128).optional(),
    awsSecretAccessKey: z.string().max(128).optional(),
    description: z.string().max(2000).nullable().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.recoveryMode === "aws-rds") {
      awsRecoveryRefine(data, ctx, false);
    } else if (data.recoveryMode === "direct" && data.host === "") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Host is required for direct connection mode",
        path: ["host"],
      });
    }
  });

export const databaseIdParamSchema = z.object({
  id: z.string().uuid(),
});

export type CreateDatabaseInput = z.infer<typeof createDatabaseSchema>;
export type UpdateDatabaseInput = z.infer<typeof updateDatabaseSchema>;
