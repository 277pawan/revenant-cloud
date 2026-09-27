import { and, desc, eq } from "drizzle-orm";
import {
  DEFAULT_RECOVERY_CONTRACT,
  RECOVERY_PROVIDERS,
  type DriftSeverity,
  type RecoveryContractDefinition,
  type RecoveryReadinessResource,
  type RecoveryVerifiedPoint,
  buildReadinessDimensionsFromJob,
  computeRecoveryReadiness,
  detectRecoveryRegression,
  extractRpoObservedSeconds,
  isFullRecoveryReadiness,
  recoveryPointLabelFromJob,
} from "@revenant/shared";
import type { Database } from "../db/index.js";
import {
  databases,
  jobResults,
  jobs,
  recoveryContracts,
  readinessSnapshots,
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

      const passJobs = await db
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
        .limit(2);

      const [lastPassJob, previousPassJob] = passJobs;

      const [lastJob] = await db
        .select()
        .from(jobs)
        .where(
          and(eq(jobs.databaseId, databaseId), eq(jobs.organizationId, organizationId))
        )
        .orderBy(desc(jobs.finishedAt))
        .limit(1);

      // Score reflects the latest drill (pass or fail), not an older passing run.
      const jobForReadiness = lastJob;

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
        latestDrillStatus: lastJob?.status ?? null,
        latestDrillAt:
          lastJob?.finishedAt?.toISOString() ?? lastJob?.createdAt?.toISOString() ?? null,
        rtoActualSeconds: jobForReadiness?.rtoSeconds ?? null,
        rpoObservedSeconds,
      });

      let previousRpo: number | null = null;
      if (previousPassJob) {
        const prevResults = await db
          .select()
          .from(jobResults)
          .where(eq(jobResults.jobId, previousPassJob.id));
        previousRpo = extractRpoObservedSeconds(
          prevResults.map((r) => ({
            checkType: r.checkType,
            status: r.status,
            message: r.message,
          }))
        );
      }

      const regression = detectRecoveryRegression({
        current: {
          jobId: lastPassJob?.id,
          finishedAt: lastPassJob?.finishedAt?.toISOString() ?? null,
          rtoSeconds: lastPassJob?.rtoSeconds ?? null,
          rpoObservedSeconds,
          score: readiness.score,
        },
        previous: previousPassJob
          ? {
              jobId: previousPassJob.id,
              finishedAt: previousPassJob.finishedAt?.toISOString() ?? null,
              rtoSeconds: previousPassJob.rtoSeconds,
              rpoObservedSeconds: previousRpo,
            }
          : null,
      });

      if (regression.detected) {
        readiness.regression = regression;
        readiness.risks.push({
          severity: regression.severity === "critical" ? "critical" : "warning",
          message: `Regression vs prior drill: ${regression.message}`,
        });
        readiness.dimensions.push({
          id: "regression",
          label: "Recovery regression",
          status: regression.severity === "critical" ? "fail" : "warn",
          detail: regression.message ?? undefined,
          weight: 0,
        });
      } else {
        readiness.regression = regression;
      }

      const lastVerifiedRecoveryPoint = await findLastVerifiedRecoveryPoint(
        db,
        organizationId,
        databaseId
      );

      return {
        databaseId: dbRow.id,
        databaseName: dbRow.name,
        contractVersion: contractRow?.version ?? 0,
        readiness,
        lastVerifiedRecoveryPoint,
        providers: [...RECOVERY_PROVIDERS],
      };
    },

  };
}

async function findLastVerifiedRecoveryPoint(
  db: Database,
  organizationId: string,
  databaseId: string
): Promise<RecoveryVerifiedPoint | null> {
  const rows = await db
    .select({
      snapshot: readinessSnapshots,
      job: jobs,
    })
    .from(readinessSnapshots)
    .innerJoin(jobs, eq(jobs.id, readinessSnapshots.jobId))
    .where(
      and(
        eq(readinessSnapshots.organizationId, organizationId),
        eq(readinessSnapshots.databaseId, databaseId),
        eq(jobs.status, "pass")
      )
    )
    .orderBy(desc(readinessSnapshots.recordedAt))
    .limit(50);

  for (const row of rows) {
    if (!isFullRecoveryReadiness(row.snapshot.status, row.snapshot.score)) {
      continue;
    }

    const results = await db
      .select()
      .from(jobResults)
      .where(eq(jobResults.jobId, row.job.id));

    const measured = results.filter((r) => r.status !== "skip");
    const failed = measured.filter((r) => r.status === "fail").length;
    const snapshotResult = results.find((r) => r.checkType === "snapshot");

    return {
      jobId: row.job.id,
      verifiedAt:
        row.job.finishedAt?.toISOString() ?? row.snapshot.recordedAt.toISOString(),
      score: row.snapshot.score,
      status: row.snapshot.status,
      rtoSeconds: row.snapshot.rtoActualSeconds,
      rpoObservedSeconds: row.snapshot.rpoObservedSeconds,
      recoveryPointLabel: recoveryPointLabelFromJob(
        row.job.trigger,
        snapshotResult?.message
      ),
      trigger: row.job.trigger,
      checksPassed: measured.length - failed,
      checksTotal: measured.length,
    };
  }

  return null;
}

export type RecoveryReadinessService = ReturnType<
  typeof createRecoveryReadinessService
>;
