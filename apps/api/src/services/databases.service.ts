import { and, count, desc, eq, ilike, sql } from "drizzle-orm";
import type { DatabaseResource, Paginated, RecoveryMode } from "@revenant/shared";
import type { Database } from "../db/index.js";
import {
  databaseAwsCredentials,
  databaseCredentials,
  databases,
  validationPlans,
} from "../db/schema.js";
import { decryptSecret, encryptSecret } from "../lib/crypto.js";
import { createAppError } from "../lib/errors.js";
import { normalizeAwsIamCredentials } from "../lib/aws-credentials.js";
import { assertRecoveryLifetimeWithinLimit } from "../lib/recovery-policy.js";
import { checkAwsSourceStatus } from "./aws-source-status.service.js";
import { assertPlanLimit, assertRecoveryModeAllowed } from "../lib/plan-limits.js";
import type {
  CreateDatabaseInput,
  UpdateDatabaseInput,
} from "../validations/databases.schema.js";
import type { DatabasesListQueryInput } from "../validations/databases.schema.js";
import {
  paginationMeta,
  paginationOffset,
} from "../validations/pagination.schema.js";

function parseRecoveryMode(value: string | null | undefined): RecoveryMode {
  return value === "aws-rds" ? "aws-rds" : "direct";
}

function toResource(
  row: typeof databases.$inferSelect,
  hasCredentials: boolean,
  hasAwsCredentials: boolean,
  plan: { name: string; version: number } | null
): DatabaseResource {
  return {
    id: row.id,
    name: row.name,
    engine: row.engine,
    host: row.host,
    port: row.port,
    databaseName: row.databaseName,
    username: row.username,
    sslMode: row.sslMode,
    region: row.region,
    recoveryMode: parseRecoveryMode(row.recoveryMode),
    rdsSourceIdentifier: row.rdsSourceIdentifier,
    recoveryUseFreetier: row.recoveryUseFreetier === "true",
    recoverySandboxInstanceClass: row.recoverySandboxInstanceClass,
    recoveryDrillsEnabled: row.recoveryDrillsEnabled === "true",
    recoveryMaxLifetimeMinutes: row.recoveryMaxLifetimeMinutes,
    recoveryCleanupCustomerSnapshots: row.recoveryCleanupCustomerSnapshots === "true",
    description: row.description,
    hasCredentials,
    hasAwsCredentials,
    hasValidationPlan: plan != null,
    validationPlanName: plan?.name ?? null,
    validationPlanVersion: plan?.version ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function createDatabasesService(db: Database, masterKey: string) {
  async function getById(
    organizationId: string,
    id: string
  ): Promise<DatabaseResource> {
    const rows = await db
      .select({
        db: databases,
        hasCredentials: sql<boolean>`(${databaseCredentials.id} is not null)`,
        hasAwsCredentials: sql<boolean>`(${databaseAwsCredentials.id} is not null)`,
        planName: validationPlans.name,
        planVersion: validationPlans.version,
      })
      .from(databases)
      .leftJoin(
        databaseCredentials,
        eq(databaseCredentials.databaseId, databases.id)
      )
      .leftJoin(
        databaseAwsCredentials,
        eq(databaseAwsCredentials.databaseId, databases.id)
      )
      .leftJoin(validationPlans, eq(validationPlans.databaseId, databases.id))
      .where(and(eq(databases.id, id), eq(databases.organizationId, organizationId)))
      .limit(1);

    const row = rows[0];
    if (!row) {
      throw createAppError(404, "Database not found", "NOT_FOUND");
    }
    const plan =
      row.planName != null && row.planVersion != null
        ? { name: row.planName, version: row.planVersion }
        : null;
    return toResource(
      row.db,
      Boolean(row.hasCredentials),
      Boolean(row.hasAwsCredentials),
      plan
    );
  }

  async function upsertCredential(
    organizationId: string,
    databaseId: string,
    plainPassword: string
  ): Promise<void> {
    const encrypted = encryptSecret(plainPassword, masterKey);
    const existing = await db
      .select({ id: databaseCredentials.id })
      .from(databaseCredentials)
      .where(eq(databaseCredentials.databaseId, databaseId))
      .limit(1);

    if (existing[0]) {
      await db
        .update(databaseCredentials)
        .set({
          ciphertext: encrypted.ciphertext,
          iv: encrypted.iv,
          authTag: encrypted.authTag,
          keyVersion: 1,
          updatedAt: new Date(),
        })
        .where(eq(databaseCredentials.id, existing[0].id));
    } else {
      await db.insert(databaseCredentials).values({
        organizationId,
        databaseId,
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        authTag: encrypted.authTag,
        keyVersion: 1,
      });
    }
  }

  async function upsertAwsCredential(
    organizationId: string,
    databaseId: string,
    accessKeyId: string,
    secretAccessKey: string,
    sessionToken?: string
  ): Promise<void> {
    let normalizedCredentials: ReturnType<typeof normalizeAwsIamCredentials>;
    try {
      normalizedCredentials = normalizeAwsIamCredentials({
        accessKeyId,
        secretAccessKey,
        sessionToken,
      });
    } catch (error) {
      throw createAppError(
        400,
        error instanceof Error ? error.message : "Invalid AWS credentials",
        "AWS_CREDENTIALS_INVALID"
      );
    }
    const payload = JSON.stringify({
      ...normalizedCredentials,
    });
    const encrypted = encryptSecret(payload, masterKey);
    const existing = await db
      .select({ id: databaseAwsCredentials.id })
      .from(databaseAwsCredentials)
      .where(eq(databaseAwsCredentials.databaseId, databaseId))
      .limit(1);

    if (existing[0]) {
      await db
        .update(databaseAwsCredentials)
        .set({
          ciphertext: encrypted.ciphertext,
          iv: encrypted.iv,
          authTag: encrypted.authTag,
          keyVersion: 1,
          updatedAt: new Date(),
        })
        .where(eq(databaseAwsCredentials.id, existing[0].id));
    } else {
      await db.insert(databaseAwsCredentials).values({
        organizationId,
        databaseId,
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        authTag: encrypted.authTag,
        keyVersion: 1,
      });
    }
  }

  async function decryptAwsCredentials(databaseId: string): Promise<{
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  } | null> {
    const cred = await db
      .select()
      .from(databaseAwsCredentials)
      .where(eq(databaseAwsCredentials.databaseId, databaseId))
      .limit(1);

    if (!cred[0]) return null;

    const json = decryptSecret(
      {
        ciphertext: cred[0].ciphertext,
        iv: cred[0].iv,
        authTag: cred[0].authTag,
      },
      masterKey
    );
    const parsed = JSON.parse(json) as {
      accessKeyId?: string;
      secretAccessKey?: string;
      sessionToken?: string;
    };
    if (!parsed.accessKeyId || !parsed.secretAccessKey) {
      return null;
    }
    return {
      accessKeyId: parsed.accessKeyId,
      secretAccessKey: parsed.secretAccessKey,
      ...(parsed.sessionToken ? { sessionToken: parsed.sessionToken } : {}),
    };
  }

  return {
    async list(
      organizationId: string,
      query: DatabasesListQueryInput
    ): Promise<Paginated<DatabaseResource>> {
      const { page, pageSize, search } = query;
      const offset = paginationOffset(page, pageSize);

      const conditions = [eq(databases.organizationId, organizationId)];
      if (search) {
        conditions.push(ilike(databases.name, `%${search}%`));
      }

      const whereClause = and(...conditions);

      const [totalRow] = await db
        .select({ value: count() })
        .from(databases)
        .where(whereClause);

      const total = Number(totalRow?.value ?? 0);

      const rows = await db
        .select({
          db: databases,
          hasCredentials: sql<boolean>`(${databaseCredentials.id} is not null)`,
          hasAwsCredentials: sql<boolean>`(${databaseAwsCredentials.id} is not null)`,
          planName: validationPlans.name,
          planVersion: validationPlans.version,
        })
        .from(databases)
        .leftJoin(
          databaseCredentials,
          eq(databaseCredentials.databaseId, databases.id)
        )
        .leftJoin(
          databaseAwsCredentials,
          eq(databaseAwsCredentials.databaseId, databases.id)
        )
        .leftJoin(validationPlans, eq(validationPlans.databaseId, databases.id))
        .where(whereClause)
        .orderBy(desc(databases.createdAt))
        .limit(pageSize)
        .offset(offset);

      return {
        data: rows.map((r) =>
          toResource(
            r.db,
            Boolean(r.hasCredentials),
            Boolean(r.hasAwsCredentials),
            r.planName != null && r.planVersion != null
              ? { name: r.planName, version: r.planVersion }
              : null
          )
        ),
        pagination: paginationMeta(total, page, pageSize),
      };
    },

    getById,

    decryptAwsCredentials,

    async checkAwsSourceStatus(organizationId: string, databaseId: string) {
      return checkAwsSourceStatus(db, masterKey, organizationId, databaseId);
    },

    async create(
      organizationId: string,
      input: CreateDatabaseInput
    ): Promise<DatabaseResource> {
      await assertPlanLimit(db, organizationId, "databases");
      const recoveryMode = input.recoveryMode ?? "aws-rds";
      await assertRecoveryModeAllowed(db, organizationId, recoveryMode);
      assertRecoveryLifetimeWithinLimit(input.recoveryMaxLifetimeMinutes);
      if (
        input.recoveryCleanupCustomerSnapshots === true &&
        input.recoveryMaxLifetimeMinutes == null
      ) {
        throw createAppError(
          400,
          "Customer-created snapshot cleanup requires an automatic deletion duration",
          "RECOVERY_RETENTION_REQUIRED"
        );
      }
      const [row] = await db
        .insert(databases)
        .values({
          organizationId,
          name: input.name,
          engine: input.engine ?? "postgres",
          host: input.host,
          port: input.port,
          databaseName: input.databaseName,
          username: input.username,
          sslMode: input.sslMode,
          region: input.region,
          recoveryMode,
          rdsSourceIdentifier:
            recoveryMode === "aws-rds" ? input.rdsSourceIdentifier : null,
          recoveryUseFreetier:
            recoveryMode === "aws-rds" && input.recoveryUseFreetier ? "true" : "false",
          recoverySandboxInstanceClass:
            recoveryMode === "aws-rds"
              ? input.recoverySandboxInstanceClass ?? null
              : null,
          recoveryDrillsEnabled:
            recoveryMode === "aws-rds" && input.recoveryDrillsEnabled === true
              ? "true"
              : "false",
          recoveryMaxLifetimeMinutes:
            recoveryMode === "aws-rds"
              ? input.recoveryMaxLifetimeMinutes ?? null
              : null,
          recoveryCleanupCustomerSnapshots:
            recoveryMode === "aws-rds" &&
            input.recoveryCleanupCustomerSnapshots === true
              ? "true"
              : "false",
          description: input.description,
        })
        .returning();

      if (input.password) {
        await upsertCredential(organizationId, row.id, input.password);
      }

      if (
        recoveryMode === "aws-rds" &&
        input.awsAccessKeyId &&
        input.awsSecretAccessKey
      ) {
        await upsertAwsCredential(
          organizationId,
          row.id,
          input.awsAccessKeyId,
          input.awsSecretAccessKey,
          input.awsSessionToken || undefined
        );
      }

      return getById(organizationId, row.id);
    },

    async update(
      organizationId: string,
      id: string,
      input: UpdateDatabaseInput
    ): Promise<DatabaseResource> {
      const currentDatabase = await getById(organizationId, id);
      assertRecoveryLifetimeWithinLimit(input.recoveryMaxLifetimeMinutes);

      const patch: Partial<typeof databases.$inferInsert> = {
        updatedAt: new Date(),
      };
      if (input.name !== undefined) patch.name = input.name;
      if (input.engine !== undefined) patch.engine = input.engine;
      if (input.host !== undefined) patch.host = input.host;
      if (input.port !== undefined) patch.port = input.port;
      if (input.databaseName !== undefined) patch.databaseName = input.databaseName;
      if (input.username !== undefined) patch.username = input.username;
      if (input.sslMode !== undefined) patch.sslMode = input.sslMode;
      if (input.region !== undefined) patch.region = input.region;
      if (input.description !== undefined) patch.description = input.description;

      if (input.recoveryMode !== undefined) {
        patch.recoveryMode = input.recoveryMode;
        if (input.recoveryMode === "direct") {
          patch.rdsSourceIdentifier = null;
          patch.recoveryUseFreetier = "false";
          patch.recoverySandboxInstanceClass = null;
          patch.recoveryDrillsEnabled = "false";
          patch.recoveryMaxLifetimeMinutes = null;
          patch.recoveryCleanupCustomerSnapshots = "false";
        }
      }
      if (input.rdsSourceIdentifier !== undefined) {
        patch.rdsSourceIdentifier = input.rdsSourceIdentifier;
      }
      if (input.recoveryUseFreetier !== undefined) {
        patch.recoveryUseFreetier = input.recoveryUseFreetier ? "true" : "false";
      }
      if (input.recoverySandboxInstanceClass !== undefined) {
        patch.recoverySandboxInstanceClass = input.recoverySandboxInstanceClass;
      }
      if (input.recoveryDrillsEnabled !== undefined) {
        if (
          input.recoveryDrillsEnabled &&
          (input.recoveryMode ?? currentDatabase.recoveryMode) !== "aws-rds"
        ) {
          throw createAppError(
            400,
            "Restore validation can only be enabled for AWS RDS databases",
            "INVALID_RECOVERY_MODE"
          );
        }
        patch.recoveryDrillsEnabled = input.recoveryDrillsEnabled ? "true" : "false";
      }
      if (input.recoveryMaxLifetimeMinutes !== undefined) {
        patch.recoveryMaxLifetimeMinutes = input.recoveryMaxLifetimeMinutes;
        if (input.recoveryMaxLifetimeMinutes === null) {
          if (input.recoveryCleanupCustomerSnapshots === true) {
            throw createAppError(
              400,
              "Customer-created snapshot cleanup requires an automatic deletion duration",
              "RECOVERY_RETENTION_REQUIRED"
            );
          }
          patch.recoveryCleanupCustomerSnapshots = "false";
        }
      }
      if (input.recoveryCleanupCustomerSnapshots !== undefined) {
        const lifetime =
          input.recoveryMaxLifetimeMinutes !== undefined
            ? input.recoveryMaxLifetimeMinutes
            : currentDatabase.recoveryMaxLifetimeMinutes;
        if (input.recoveryCleanupCustomerSnapshots && lifetime === null) {
          throw createAppError(
            400,
            "Set an automatic deletion duration before enabling cleanup of customer-created snapshots",
            "RECOVERY_RETENTION_REQUIRED"
          );
        }
        patch.recoveryCleanupCustomerSnapshots =
          input.recoveryCleanupCustomerSnapshots ? "true" : "false";
      }

      await db
        .update(databases)
        .set(patch)
        .where(and(eq(databases.id, id), eq(databases.organizationId, organizationId)));

      if (input.password !== undefined && input.password !== "") {
        await upsertCredential(organizationId, id, input.password);
      }

      if (input.awsAccessKeyId && input.awsSecretAccessKey) {
        await upsertAwsCredential(
          organizationId,
          id,
          input.awsAccessKeyId,
          input.awsSecretAccessKey,
          input.awsSessionToken || undefined
        );
      }

      return getById(organizationId, id);
    },

    async delete(organizationId: string, id: string) {
      const [row] = await db
        .delete(databases)
        .where(and(eq(databases.id, id), eq(databases.organizationId, organizationId)))
        .returning({ id: databases.id });

      if (!row) {
        throw createAppError(404, "Database not found", "NOT_FOUND");
      }
    },
  };
}

export type DatabasesService = ReturnType<typeof createDatabasesService>;
