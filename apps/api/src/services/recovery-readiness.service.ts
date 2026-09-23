import { and, desc, eq } from "drizzle-orm";
import {
  DEFAULT_RECOVERY_CONTRACT,
  RECOVERY_PROVIDERS,
  type DriftSeverity,
  type RecoveryContractDefinition,
  type RecoveryReadinessResource,
  buildReadinessDimensionsFromJob,
  computeRecoveryReadiness,
  extractRpoObservedSeconds,
} from "@revenant/shared";
import type { Database } from "../db/index.js";
import {
  databases,
  jobResults,
  jobs,
  recoveryContracts,
  recoveryDriftEvents,
  recoveryFingerprints,
  schedules,
  validationPlans,
} from "../db/schema.js";
import { createAppError } from "../lib/errors.js";

export function createRecoveryReadinessService(db: Database) {
  return {
    async getForDatabase(
      organizationId: string,
      databaseId: string
    ): Promise<RecoveryReadinessResource> {
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

      const [contractRow] = await db
        .select()
        .from(recoveryContracts)
        .where(eq(recoveryContracts.databaseId, databaseId))
        .limit(1);

      const contract: RecoveryContractDefinition = contractRow
        ? (contractRow.definitionJson as RecoveryContractDefinition)
        : DEFAULT_RECOVERY_CONTRACT;

      const [planRow] = await db
        .select()
        .from(validationPlans)
        .where(eq(validationPlans.databaseId, databaseId))
        .limit(1);

      const [scheduleRow] = await db
        .select()
        .from(schedules)
        .where(eq(schedules.databaseId, databaseId))
        .limit(1);

      const [lastPassJob] = await db
        .select()
        .from(jobs)
        .where(
          and(
            eq(jobs.databaseId, databaseId),
            eq(jobs.organizationId, organizationId),
            eq(jobs.status, "pass")
          )
        )
        .orderBy(desc(jobs.finishedAt))
        .limit(1);

      const [lastJob] = await db
        .select()
        .from(jobs)
        .where(
          and(eq(jobs.databaseId, databaseId), eq(jobs.organizationId, organizationId))
        )
        .orderBy(desc(jobs.finishedAt))
        .limit(1);

      const jobForReadiness = lastPassJob ?? lastJob;

      const results =
        jobForReadiness
          ? await db
              .select()
              .from(jobResults)
              .where(eq(jobResults.jobId, jobForReadiness.id))
          : [];

      const dependencies = contract.recovery.dependencies ?? [];
      const mappedResults = results.map((r) => ({
        checkType: r.checkType,
        status: r.status,
        message: r.message,
      }));
      const rpoObservedSeconds = extractRpoObservedSeconds(mappedResults);
      const httpHealthPasses = mappedResults.filter(
        (r) => r.checkType === "http_health" && r.status === "pass"
      ).length;
      const testedDependencyCount =
        dependencies.length === 0
          ? 0
          : Math.min(httpHealthPasses, dependencies.length);

      const dimensions = buildReadinessDimensionsFromJob({
        contract,
        lastJobStatus: jobForReadiness?.status ?? null,
        lastJobFinishedAt: jobForReadiness?.finishedAt?.toISOString() ?? null,
        rtoActualSeconds: jobForReadiness?.rtoSeconds ?? null,
        rpoObservedSeconds,
        checkResults: mappedResults,
        hasValidationPlan: planRow != null,
        hasSchedule: scheduleRow?.enabled === "true",
        dependencyCount: dependencies.length,
        testedDependencyCount,
      });

      const [latestDrift] = await db
        .select()
        .from(recoveryDriftEvents)
        .where(
          and(
            eq(recoveryDriftEvents.databaseId, databaseId),
            eq(recoveryDriftEvents.organizationId, organizationId),
            eq(recoveryDriftEvents.status, "open")
          )
        )
        .orderBy(desc(recoveryDriftEvents.createdAt))
        .limit(1);

      const [latestFingerprint] = await db
        .select()
        .from(recoveryFingerprints)
        .where(eq(recoveryFingerprints.databaseId, databaseId))
        .orderBy(desc(recoveryFingerprints.createdAt))
        .limit(1);

      let driftStatus: DriftSeverity = "stable";
      let driftSummary: string | null = null;
      if (latestDrift) {
        driftStatus = latestDrift.severity as DriftSeverity;
        driftSummary = latestDrift.description;
      } else if (
        latestFingerprint &&
        planRow &&
        (latestFingerprint.fingerprintJson as { validationPlanVersion?: number })
          .validationPlanVersion !== planRow.version
      ) {
        driftStatus = "minor_drift";
        driftSummary = "Validation plan changed since last verified recovery";
      }

      const readiness = computeRecoveryReadiness({
        contract,
        dimensions,
        driftStatus,
        driftSummary,
        lastVerifiedAt: lastPassJob?.finishedAt?.toISOString() ?? null,
        rtoActualSeconds: lastPassJob?.rtoSeconds ?? null,
        rpoObservedSeconds,
      });

      return {
        databaseId: dbRow.id,
        databaseName: dbRow.name,
        contractVersion: contractRow?.version ?? 0,
        readiness,
        providers: [...RECOVERY_PROVIDERS],
      };
    },

  };
}

export type RecoveryReadinessService = ReturnType<
  typeof createRecoveryReadinessService
>;
