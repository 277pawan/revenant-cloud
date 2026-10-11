import { z } from "zod";
import { paginationQuerySchema } from "./pagination.schema.js";

export const databasesListQuerySchema = paginationQuerySchema.extend({
  search: z.string().trim().max(255).optional(),
});

export type DatabasesListQueryInput = z.infer<typeof databasesListQuerySchema>;

const recoveryModeSchema = z.enum(["direct", "aws-rds"]);
const mongodbConnectionStringSchema = z
  .string()
  .trim()
  .min(1)
  .max(4096)
  .refine((value) => {
    if (!/^mongodb(?:\+srv)?:\/\//i.test(value) || /\s/.test(value)) {
      return false;
    }
    try {
      const uri = new URL(value);
      return Boolean(uri.hostname) && !uri.hash;
    } catch {
      return false;
    }
  }, "Connection string must be a valid mongodb:// or mongodb+srv:// URI");

type MongoDirectInput = {
  host?: string | null;
  port?: number | null;
  username?: string | null;
  password?: string | null;
  sslMode?: string | null;
  region?: string | null;
  rdsSourceIdentifier?: string | null;
  recoveryUseFreetier?: boolean | null;
  recoverySandboxInstanceClass?: string | null;
  recoveryDrillsEnabled?: boolean | null;
  recoveryMaxLifetimeMinutes?: number | null;
  recoveryCleanupCustomerSnapshots?: boolean | null;
  awsAccessKeyId?: string | null;
  awsSecretAccessKey?: string | null;
  awsSessionToken?: string | null;
};

function rejectMongoAwsSettings(data: MongoDirectInput, ctx: z.RefinementCtx) {
  const unsupportedSettings: Array<[string, unknown]> = [
    ["host", data.host],
    ["port", data.port],
    ["username", data.username],
    ["password", data.password],
    ["sslMode", data.sslMode],
    ["region", data.region],
    ["rdsSourceIdentifier", data.rdsSourceIdentifier],
    ["recoveryUseFreetier", data.recoveryUseFreetier],
    ["recoverySandboxInstanceClass", data.recoverySandboxInstanceClass],
    ["recoveryDrillsEnabled", data.recoveryDrillsEnabled],
    ["recoveryMaxLifetimeMinutes", data.recoveryMaxLifetimeMinutes],
    ["recoveryCleanupCustomerSnapshots", data.recoveryCleanupCustomerSnapshots],
    ["awsAccessKeyId", data.awsAccessKeyId],
    ["awsSecretAccessKey", data.awsSecretAccessKey],
    ["awsSessionToken", data.awsSessionToken],
  ];
  for (const [field, value] of unsupportedSettings) {
    if (value !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "MongoDB uses only a direct connection URI; host, region, and AWS/RDS settings are unsupported",
        path: [field],
      });
    }
  }
}

const awsRecoveryRefine = (
  data: {
    recoveryMode?: string;
    host?: string | null;
    region?: string | null;
    port?: number | null;
    sslMode?: string | null;
    rdsSourceIdentifier?: string | null;
    username?: string | null;
    password?: string | null;
    awsAccessKeyId?: string | null;
    awsSecretAccessKey?: string | null;
    awsSessionToken?: string | null;
    recoveryUseFreetier?: boolean | null;
    recoverySandboxInstanceClass?: string | null;
    recoveryDrillsEnabled?: boolean | null;
    recoveryMaxLifetimeMinutes?: number | null;
    recoveryCleanupCustomerSnapshots?: boolean | null;
    engine?: string;
    connectionString?: string | null;
    databaseName?: string | null;
  },
  ctx: z.RefinementCtx,
  requireAwsKeys: boolean
) => {
  const mode = data.recoveryMode ?? "direct";
  if (data.engine === "mongodb") {
    if (mode !== "direct") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "MongoDB direct validation does not support AWS/RDS restore mode",
        path: ["recoveryMode"],
      });
      return;
    }
    if (!data.connectionString?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "MongoDB connection string is required",
        path: ["connectionString"],
      });
    }
    if (!data.databaseName?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "MongoDB database name is required",
        path: ["databaseName"],
      });
    }
    rejectMongoAwsSettings(data, ctx);
    return;
  }
  if (data.connectionString) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Connection string is only supported for MongoDB",
      path: ["connectionString"],
    });
  }
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
    engine: z.enum(["postgres", "mysql", "mongodb"]).default("postgres"),
    host: z.string().max(255).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    databaseName: z.string().max(255).optional(),
    username: z.string().max(255).optional(),
    password: z.string().min(1).max(512).optional(),
    connectionString: mongodbConnectionStringSchema.optional(),
    sslMode: z.enum(["require", "prefer", "disable"]).optional(),
    region: z.string().max(50).optional(),
    recoveryMode: recoveryModeSchema.default("direct"),
    rdsSourceIdentifier: z.string().max(255).optional(),
    recoveryUseFreetier: z.boolean().optional(),
    recoverySandboxInstanceClass: z.string().max(50).optional(),
    recoveryDrillsEnabled: z.boolean().optional(),
    recoveryMaxLifetimeMinutes: z.number().int().min(10).max(2147483647).nullable().optional(),
    recoveryCleanupCustomerSnapshots: z.boolean().optional(),
    awsAccessKeyId: z.string().max(128).optional(),
    awsSecretAccessKey: z.string().max(128).optional(),
    awsSessionToken: z.string().max(2048).optional(),
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
    engine: z.enum(["postgres", "mysql", "mongodb"]).optional(),
    host: z.string().max(255).nullable().optional(),
    port: z.number().int().min(1).max(65535).nullable().optional(),
    databaseName: z.string().max(255).nullable().optional(),
    username: z.string().max(255).nullable().optional(),
    /** omit = unchanged; "" = clear; non-empty = re-encrypt */
    password: z.string().max(512).optional(),
    connectionString: mongodbConnectionStringSchema.optional(),
    sslMode: z.enum(["require", "prefer", "disable"]).nullable().optional(),
    region: z.string().max(50).nullable().optional(),
    recoveryMode: recoveryModeSchema.optional(),
    rdsSourceIdentifier: z.string().max(255).nullable().optional(),
    recoveryUseFreetier: z.boolean().optional(),
    recoverySandboxInstanceClass: z.string().max(50).nullable().optional(),
    recoveryDrillsEnabled: z.boolean().optional(),
    recoveryMaxLifetimeMinutes: z.number().int().min(10).max(2147483647).nullable().optional(),
    recoveryCleanupCustomerSnapshots: z.boolean().optional(),
    awsAccessKeyId: z.string().max(128).optional(),
    awsSecretAccessKey: z.string().max(128).optional(),
    awsSessionToken: z.string().max(2048).optional(),
    description: z.string().max(2000).nullable().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.engine === "mongodb") {
      if (data.recoveryMode === "aws-rds") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "MongoDB direct validation does not support AWS/RDS restore mode",
          path: ["recoveryMode"],
        });
      }
      rejectMongoAwsSettings(data, ctx);
      if (data.databaseName !== undefined && !data.databaseName?.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "MongoDB database name cannot be empty",
          path: ["databaseName"],
        });
      }
    } else if (
      data.connectionString &&
      data.engine !== undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Connection string is only supported for MongoDB",
        path: ["connectionString"],
      });
    }
    if (data.engine !== "mongodb" && data.recoveryMode !== undefined) {
      if (data.recoveryMode === "aws-rds") {
        awsRecoveryRefine(data, ctx, false);
      } else if (data.recoveryMode === "direct" && data.host === "") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Host is required for direct connection mode",
          path: ["host"],
        });
      }
    }
  });

export const databaseIdParamSchema = z.object({
  id: z.string().uuid(),
});

export type CreateDatabaseInput = z.infer<typeof createDatabaseSchema>;
export type UpdateDatabaseInput = z.infer<typeof updateDatabaseSchema>;
