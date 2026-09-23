import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { JobDetailResource, RecoveryFingerprintPayload } from "@revenant/shared";
import type { Database } from "../db/index.js";
import {
  databases,
  recoveryContracts,
  recoveryFingerprints,
  validationPlans,
} from "../db/schema.js";
import type { RecoveryContractDefinition } from "@revenant/shared";

export function createRecoveryFingerprintService(db: Database) {
  return {
    async recordFromJob(
      organizationId: string,
      job: JobDetailResource
    ): Promise<string | null> {
      if (job.status !== "pass") return null;

      const [dbRow] = await db
        .select()
        .from(databases)
        .where(eq(databases.id, job.databaseId))
        .limit(1);

      const [planRow] = await db
        .select()
        .from(validationPlans)
        .where(eq(validationPlans.databaseId, job.databaseId))
        .limit(1);

      const [contractRow] = await db
        .select()
        .from(recoveryContracts)
        .where(eq(recoveryContracts.databaseId, job.databaseId))
        .limit(1);

      const contract = (contractRow?.definitionJson ??
        {}) as RecoveryContractDefinition;

      const schemaChecks = job.results
        .filter((r) => ["schema", "table", "index"].includes(r.checkType))
        .map((r) => r.checkName)
        .sort();

      const payload: RecoveryFingerprintPayload = {
        database: {
          engine: dbRow?.engine ?? "postgres",
          schemaHash: createHash("sha256")
            .update(schemaChecks.join("|"))
            .digest("hex"),
          tableCount: schemaChecks.length,
        },
        application: {
          contractHash: contractRow
            ? createHash("sha256")
                .update(JSON.stringify(contractRow.definitionJson))
                .digest("hex")
            : undefined,
        },
        dependencies: contract.recovery?.dependencies ?? [],
        validationPlanVersion: planRow?.version,
      };

      const [row] = await db
        .insert(recoveryFingerprints)
        .values({
          organizationId,
          databaseId: job.databaseId,
          jobId: job.id,
          fingerprintJson: payload,
        })
        .returning({ id: recoveryFingerprints.id });

      return row.id;
    },
  };
}

export type RecoveryFingerprintService = ReturnType<
  typeof createRecoveryFingerprintService
>;
