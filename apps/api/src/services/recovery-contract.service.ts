import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  DEFAULT_RECOVERY_CONTRACT,
  type RecoveryContractDefinition,
  parseDurationToSeconds,
} from "@revenant/shared";
import type { Database } from "../db/index.js";
import { databases, recoveryContracts } from "../db/schema.js";
import { createAppError } from "../lib/errors.js";
import {
  parseRecoveryContractYaml,
  recoveryContractToYaml,
} from "../lib/recovery-contract-yaml.js";
import type { UpsertRecoveryContractInput } from "../validations/recovery-contract.schema.js";
import { recoveryContractDefinitionSchema } from "../validations/recovery-contract.schema.js";

export interface RecoveryContractResource {
  id: string;
  databaseId: string;
  databaseName: string;
  version: number;
  definition: RecoveryContractDefinition;
  yamlText: string;
  rtoSeconds: number | null;
  rpoSeconds: number | null;
  status: string;
  contractHash: string;
  createdAt: string;
  updatedAt: string;
}

function contractHash(definition: RecoveryContractDefinition): string {
  return createHash("sha256")
    .update(JSON.stringify(definition))
    .digest("hex");
}

function toResource(
  row: typeof recoveryContracts.$inferSelect,
  databaseName: string,
  definition: RecoveryContractDefinition
): RecoveryContractResource {
  return {
    id: row.id,
    databaseId: row.databaseId,
    databaseName,
    version: row.version,
    definition,
    yamlText: recoveryContractToYaml(definition),
    rtoSeconds: row.rtoSeconds,
    rpoSeconds: row.rpoSeconds,
    status: row.status,
    contractHash: contractHash(definition),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function resolveDefinition(input: UpsertRecoveryContractInput): RecoveryContractDefinition {
  if (input.yamlText) {
    try {
      return parseRecoveryContractYaml(input.yamlText);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Invalid YAML";
      throw createAppError(400, message, "VALIDATION_ERROR");
    }
  }
  if (input.definition) {
    const parsed = recoveryContractDefinitionSchema.parse(input.definition);
    return parsed as RecoveryContractDefinition;
  }
  throw createAppError(400, "yamlText or definition is required", "VALIDATION_ERROR");
}

export function createRecoveryContractService(db: Database) {
  return {
    async ensureDefault(organizationId: string, databaseId: string): Promise<void> {
      const [existing] = await db
        .select({ id: recoveryContracts.id })
        .from(recoveryContracts)
        .where(eq(recoveryContracts.databaseId, databaseId))
        .limit(1);

      if (existing) return;

      await db.insert(recoveryContracts).values({
        organizationId,
        databaseId,
        version: 1,
        definitionJson: DEFAULT_RECOVERY_CONTRACT,
        rtoSeconds: parseDurationToSeconds(DEFAULT_RECOVERY_CONTRACT.recovery.rto),
        rpoSeconds: parseDurationToSeconds(DEFAULT_RECOVERY_CONTRACT.recovery.rpo),
        status: "active",
      });
    },

    async get(
      organizationId: string,
      databaseId: string
    ): Promise<RecoveryContractResource> {
      const [row] = await db
        .select({
          contract: recoveryContracts,
          databaseName: databases.name,
        })
        .from(recoveryContracts)
        .innerJoin(databases, eq(databases.id, recoveryContracts.databaseId))
        .where(
          and(
            eq(recoveryContracts.databaseId, databaseId),
            eq(recoveryContracts.organizationId, organizationId)
          )
        )
        .limit(1);

      if (!row) {
        await this.ensureDefault(organizationId, databaseId);
        return this.get(organizationId, databaseId);
      }

      const definition = row.contract.definitionJson as RecoveryContractDefinition;
      return toResource(row.contract, row.databaseName, definition);
    },

    async upsert(
      organizationId: string,
      databaseId: string,
      input: UpsertRecoveryContractInput
    ): Promise<RecoveryContractResource> {
      const [dbRow] = await db
        .select()
        .from(databases)
        .where(
          and(eq(databases.id, databaseId), eq(databases.organizationId, organizationId))
        )
        .limit(1);

      if (!dbRow) {
        throw createAppError(404, "Database not found", "NOT_FOUND");
      }

      const definition = resolveDefinition(input);
      const rtoSeconds = parseDurationToSeconds(definition.recovery.rto);
      const rpoSeconds = parseDurationToSeconds(definition.recovery.rpo);

      const [existing] = await db
        .select()
        .from(recoveryContracts)
        .where(eq(recoveryContracts.databaseId, databaseId))
        .limit(1);

      if (existing) {
        const [updated] = await db
          .update(recoveryContracts)
          .set({
            version: existing.version + 1,
            definitionJson: definition,
            rtoSeconds,
            rpoSeconds,
            updatedAt: new Date(),
          })
          .where(eq(recoveryContracts.id, existing.id))
          .returning();

        return toResource(updated, dbRow.name, definition);
      }

      const [created] = await db.insert(recoveryContracts).values({
        organizationId,
        databaseId,
        version: 1,
        definitionJson: definition,
        rtoSeconds,
        rpoSeconds,
        status: "active",
      }).returning();

      return toResource(created, dbRow.name, definition);
    },
  };
}

export type RecoveryContractService = ReturnType<typeof createRecoveryContractService>;
