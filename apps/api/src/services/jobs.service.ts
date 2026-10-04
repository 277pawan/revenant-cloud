import { and, count, desc, eq, ilike, or } from "drizzle-orm";
import type {
  JobDetailResource,
  JobResource,
  JobResultResource,
  Paginated,
  RecoveryContractDefinition,
  RunnerProgressCheck,
} from "@revenant/shared";
import type { Database } from "../db/index.js";
import {
  databaseAwsCredentials,
  databaseCredentials,
  databases,
  jobResults,
  jobs,
  recoveryPoints,
  recoveryContracts,
  validationPlans,
} from "../db/schema.js";
import { decryptSecret } from "../lib/crypto.js";
import { createAppError } from "../lib/errors.js";
import {
  assertRecoveryLifetimeWithinLimit,
} from "../lib/recovery-policy.js";
import {
  assertAwsFullDrillSourceAvailable,
  checkAwsSourceStatus,
} from "./aws-source-status.service.js";
import {
  assertSandboxConcurrency,
  assertSelfHostedAgentAllowed,
  assertSubscriptionActive,
} from "../lib/plan-limits.js";
import type { RunnerAuthContext } from "../middleware/runner.js";
import type {
  CompleteJobInput,
  CreateJobInput,
  JobProgressInput,
  ListJobsQueryInput,
} from "../validations/jobs.schema.js";
import { paginationMeta, paginationOffset } from "../validations/pagination.schema.js";

function toJob(
  row: typeof jobs.$inferSelect,
  databaseName: string
): JobResource {
  const metadata = isRecord(row.metadataJson) ? row.metadataJson : null;
  const progress = metadata?.runnerProgress;
  const runnerProgress = isRecord(progress) ? progress : null;
  return {
    id: row.id,
    databaseId: row.databaseId,
    databaseName,
    status: row.status,
    trigger: row.trigger,
    executionMode: row.executionMode,
    triggeredByUserId: row.triggeredByUserId,
    errorMessage: row.errorMessage,
    rtoSeconds: row.rtoSeconds,
    runnerProgress:
      typeof runnerProgress?.stage === "string" &&
      typeof runnerProgress.message === "string" &&
      typeof runnerProgress.updatedAt === "string"
        ? {
            stage: runnerProgress.stage,
            message: runnerProgress.message,
            updatedAt: runnerProgress.updatedAt,
            ...(Array.isArray(runnerProgress.checks)
              ? { checks: runnerProgress.checks.filter(isRunnerProgressCheck) }
              : {}),
          }
        : null,
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function isRunnerProgressCheck(value: unknown): value is RunnerProgressCheck {
  return (
    isRecord(value) &&
    typeof value.checkName === "string" &&
    typeof value.checkType === "string" &&
    (value.status === "pass" || value.status === "fail" || value.status === "skip") &&
    (value.message === null || typeof value.message === "string")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toResult(row: typeof jobResults.$inferSelect): JobResultResource {
  return {
    id: row.id,
    checkName: row.checkName,
    checkType: row.checkType,
    status: row.status,
    message: row.message,
    durationMs: row.durationMs,
    createdAt: row.createdAt.toISOString(),
  };
}

export function createJobsService(db: Database, masterKey: string) {
  return {
  async list(
    organizationId: string,
    pagination: ListJobsQueryInput
  ): Promise<Paginated<JobResource>> {
    const { page, pageSize, databaseId, search } = pagination;
    const offset = paginationOffset(page, pageSize);

    const conditions = [eq(jobs.organizationId, organizationId)];
    if (databaseId) {
      conditions.push(eq(jobs.databaseId, databaseId));
    }
    if (search) {
      const term = `%${search}%`;
      conditions.push(
        or(
          ilike(jobs.id, term),
          ilike(jobs.status, term),
          ilike(jobs.trigger, term),
          ilike(databases.name, term)
        )!
      );
    }
    const whereClause = and(...conditions);

    const [totalRow] = await db
      .select({ value: count() })
      .from(jobs)
      .innerJoin(databases, eq(databases.id, jobs.databaseId))
      .where(whereClause);

    const total = Number(totalRow?.value ?? 0);

    const rows = await db
      .select({
        job: jobs,
        databaseName: databases.name,
      })
      .from(jobs)
      .innerJoin(databases, eq(databases.id, jobs.databaseId))
      .where(whereClause)
      .orderBy(desc(jobs.createdAt))
      .limit(pageSize)
      .offset(offset);

    return {
      data: rows.map((r) => toJob(r.job, r.databaseName)),
      pagination: paginationMeta(total, page, pageSize),
    };
  },

  async getById(organizationId: string, id: string): Promise<JobDetailResource> {
    const rows = await db
      .select({
        job: jobs,
        databaseName: databases.name,
      })
      .from(jobs)
      .innerJoin(databases, eq(databases.id, jobs.databaseId))
      .where(and(eq(jobs.id, id), eq(jobs.organizationId, organizationId)))
      .limit(1);

    if (!rows[0]) {
      throw createAppError(404, "Job not found", "NOT_FOUND");
    }

    const results = await db
      .select()
      .from(jobResults)
      .where(eq(jobResults.jobId, id))
      .orderBy(jobResults.createdAt);

    return {
      ...toJob(rows[0].job, rows[0].databaseName),
      results: results.map(toResult),
    };
  },

  async createFromSchedule(
    organizationId: string,
    databaseId: string
  ): Promise<JobResource> {
    const dbRows = await db
      .select()
      .from(databases)
      .where(
        and(
          eq(databases.id, databaseId),
          eq(databases.organizationId, organizationId)
        )
      )
      .limit(1);

    if (!dbRows[0]) {
      throw createAppError(404, "Database not found", "NOT_FOUND");
    }

    if (
      dbRows[0].recoveryMode === "aws-rds" &&
      dbRows[0].recoveryDrillsEnabled !== "true"
    ) {
      throw createAppError(
        409,
        "Recovery validation drills are disabled for this database. Enable them in Recovery Operations before starting a drill.",
        "RECOVERY_DRILLS_DISABLED"
      );
    }
    assertRecoveryLifetimeWithinLimit(dbRows[0].recoveryMaxLifetimeMinutes);

    if (dbRows[0].recoveryMode === "aws-rds") {
      try {
        const awsStatus = await checkAwsSourceStatus(
          db,
          masterKey,
          organizationId,
          databaseId
        );
        assertAwsFullDrillSourceAvailable(awsStatus);
      } catch (error) {
        console.error(
          `[jobs] scheduled full drill blocked database=${databaseId}:`,
          error instanceof Error ? error.message : error
        );
        throw error;
      }
    }

    await assertSubscriptionActive(db, organizationId);
    await assertSandboxConcurrency(db, organizationId);

    const [job] = await db
      .insert(jobs)
      .values({
        organizationId,
        databaseId,
        status: "pending",
        trigger: "schedule",
        triggeredByUserId: null,
      })
      .returning();

    return toJob(job, dbRows[0].name);
  },

  async create(
    organizationId: string,
    userId: string,
    input: CreateJobInput
  ): Promise<JobResource> {
    const dbRows = await db
      .select()
      .from(databases)
      .where(
        and(
          eq(databases.id, input.databaseId),
          eq(databases.organizationId, organizationId)
        )
      )
      .limit(1);

    if (!dbRows[0]) {
      throw createAppError(404, "Database not found", "NOT_FOUND");
    }

    if (
      dbRows[0].recoveryMode === "aws-rds" &&
      dbRows[0].recoveryDrillsEnabled !== "true"
    ) {
      throw createAppError(
        409,
        "Recovery validation drills are disabled for this database. Enable them in Recovery Operations before starting a drill.",
        "RECOVERY_DRILLS_DISABLED"
      );
    }
    assertRecoveryLifetimeWithinLimit(dbRows[0].recoveryMaxLifetimeMinutes);

    let verificationSnapshotIdentifier: string | null = null;
    if (input.recoveryPointId) {
      if (input.drillKind !== "verify" || dbRows[0].recoveryMode !== "aws-rds") {
        throw createAppError(
          400,
          "A recovery point can only be verified with an AWS snapshot verification job",
          "INVALID_RECOVERY_POINT_VERIFICATION"
        );
      }
      const [point] = await db
        .select({ snapshotIdentifier: recoveryPoints.snapshotIdentifier })
        .from(recoveryPoints)
        .where(
          and(
            eq(recoveryPoints.id, input.recoveryPointId),
            eq(recoveryPoints.organizationId, organizationId),
            eq(recoveryPoints.databaseId, input.databaseId),
            eq(recoveryPoints.status, "active")
          )
        )
        .limit(1);
      if (!point) {
        throw createAppError(
          404,
          "Recovery point is no longer available",
          "RECOVERY_POINT_NOT_FOUND"
        );
      }
      verificationSnapshotIdentifier = point.snapshotIdentifier;
    }

    const plan = await db
      .select({ id: validationPlans.id })
      .from(validationPlans)
      .where(
        and(
          eq(validationPlans.databaseId, input.databaseId),
          eq(validationPlans.organizationId, organizationId)
        )
      )
      .limit(1);

    if (!plan[0]) {
      throw createAppError(
        400,
        "Save a validation plan for this database before running a job",
        "NO_VALIDATION_PLAN"
      );
    }

    if (
      dbRows[0].recoveryMode === "aws-rds" &&
      input.drillKind !== "verify"
    ) {
      try {
        const awsStatus = await checkAwsSourceStatus(
          db,
          masterKey,
          organizationId,
          input.databaseId
        );
        assertAwsFullDrillSourceAvailable(awsStatus);
      } catch (error) {
        console.error(
          `[jobs] full drill blocked database=${input.databaseId} ` +
            `drillKind=${input.drillKind}:`,
          error instanceof Error ? error.message : error
        );
        throw error;
      }
    }

    await assertSubscriptionActive(db, organizationId);
    await assertSandboxConcurrency(db, organizationId);

    const [job] = await db
      .insert(jobs)
      .values({
        organizationId,
        databaseId: input.databaseId,
        status: "pending",
        trigger: input.drillKind === "verify" ? "manual" : "full-drill",
        triggeredByUserId: userId,
        ...(verificationSnapshotIdentifier
          ? { metadataJson: { verificationSnapshotIdentifier } }
          : {}),
      })
      .returning();

    return toJob(job, dbRows[0].name);
  },

  /**
   * Claim next pending job for this runner's validation plan (database).
   * Org agent only sees jobs for its database — not org-wide first-come-first-served.
   */
  async claimNext(auth: RunnerAuthContext) {
    if (auth.type === "org") {
      await assertSelfHostedAgentAllowed(db, auth.organizationId);
      await assertSubscriptionActive(db, auth.organizationId);
    }

    const conditions = [eq(jobs.status, "pending")];
    if (auth.type === "org") {
      conditions.push(eq(jobs.organizationId, auth.organizationId));
      conditions.push(eq(jobs.databaseId, auth.databaseId));
    }

    const pending = await db
      .select({
        job: jobs,
        database: databases,
      })
      .from(jobs)
      .innerJoin(databases, eq(databases.id, jobs.databaseId))
      .where(and(...conditions))
      .orderBy(jobs.createdAt)
      .limit(1);

    if (!pending[0]) {
      return null;
    }

    const { job, database } = pending[0];
    const executionMode = auth.type === "stub" ? "stub" : auth.kind;
    const claimedByRunnerId = auth.type === "org" ? auth.runnerId : null;

    const [updated] = await db
      .update(jobs)
      .set({
        status: "running",
        executionMode,
        claimedByRunnerId,
        metadataJson: {
          ...(isRecord(job.metadataJson) ? job.metadataJson : {}),
          runnerProgress: {
            stage: "runner_starting",
            message: "Runner claimed the job and is preparing the selected database.",
            updatedAt: new Date().toISOString(),
          },
        },
        startedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(jobs.id, job.id), eq(jobs.status, "pending")))
      .returning();

    if (!updated) {
      return null;
    }

    const cred = await db
      .select()
      .from(databaseCredentials)
      .where(eq(databaseCredentials.databaseId, database.id))
      .limit(1);

    let password: string | null = null;
    if (cred[0]) {
      password = decryptSecret(
        {
          ciphertext: cred[0].ciphertext,
          iv: cred[0].iv,
          authTag: cred[0].authTag,
        },
        masterKey
      );
    }

    let awsCredentials: {
      accessKeyId: string;
      secretAccessKey: string;
      sessionToken?: string;
    } | null = null;
    if (database.recoveryMode === "aws-rds") {
      const awsCred = await db
        .select()
        .from(databaseAwsCredentials)
        .where(eq(databaseAwsCredentials.databaseId, database.id))
        .limit(1);

      if (awsCred[0]) {
        const json = decryptSecret(
          {
            ciphertext: awsCred[0].ciphertext,
            iv: awsCred[0].iv,
            authTag: awsCred[0].authTag,
          },
          masterKey
        );
        const parsed = JSON.parse(json) as {
          accessKeyId?: string;
          secretAccessKey?: string;
          sessionToken?: string;
        };
        if (parsed.accessKeyId && parsed.secretAccessKey) {
          awsCredentials = {
            accessKeyId: parsed.accessKeyId,
            secretAccessKey: parsed.secretAccessKey,
            ...(parsed.sessionToken ? { sessionToken: parsed.sessionToken } : {}),
          };
        }
      }
    }

    const plan = await db
      .select()
      .from(validationPlans)
      .where(eq(validationPlans.databaseId, database.id))
      .limit(1);

    const [contractRow] = await db
      .select()
      .from(recoveryContracts)
      .where(eq(recoveryContracts.databaseId, database.id))
      .limit(1);

    const contractDef = (contractRow?.definitionJson ?? {}) as RecoveryContractDefinition;
    const healthcheckRequired =
      contractDef.recovery?.required?.healthcheck === true ||
      contractDef.recovery?.required?.api === true;
    const contractApplication =
      healthcheckRequired && contractDef.recovery?.application
        ? {
            healthcheck: contractDef.recovery.application.healthcheck,
            endpoints: contractDef.recovery.application.endpoints,
          }
        : null;

    const recoveryMode = database.recoveryMode === "aws-rds" ? "aws-rds" : "direct";
    const verificationSnapshotIdentifier =
      isRecord(job.metadataJson) &&
      typeof job.metadataJson.verificationSnapshotIdentifier === "string"
        ? job.metadataJson.verificationSnapshotIdentifier
        : null;
    const recovery =
      recoveryMode === "aws-rds" && database.rdsSourceIdentifier && database.region
        ? {
            engine: "aws-rds" as const,
            sourceIdentifier: database.rdsSourceIdentifier,
            region: database.region,
            ...(verificationSnapshotIdentifier
              ? { snapshotIdentifier: verificationSnapshotIdentifier }
              : {}),
            useFreetier: database.recoveryUseFreetier === "true",
            sandboxInstanceClass: database.recoverySandboxInstanceClass,
            maxLifetimeMinutes:
              database.recoveryMaxLifetimeMinutes,
            cleanupCustomerSnapshots:
              database.recoveryCleanupCustomerSnapshots === "true",
          }
        : null;

    return {
      job: toJob(updated, database.name),
      database: {
        id: database.id,
        name: database.name,
        engine: database.engine === "mysql" ? "mysql" : "postgres",
        host: database.host,
        port: database.port,
        databaseName: database.databaseName,
        username: database.username,
        sslMode: database.sslMode,
        region: database.region,
        recoveryMode,
      },
      password,
      recovery,
      awsCredentials,
      planYaml: plan[0]?.yamlText ?? null,
      planVersion: plan[0]?.version ?? null,
      contractApplication,
      executionMode,
      fullDrill:
        updated.trigger === "full-drill" ||
        (recoveryMode === "aws-rds" && updated.trigger === "schedule"),
    };
  },

  async updateRunnerProgress(
    jobId: string,
    input: JobProgressInput,
    auth?: RunnerAuthContext
  ): Promise<void> {
    const [row] = await db
      .select({
        job: jobs,
      })
      .from(jobs)
      .where(eq(jobs.id, jobId))
      .limit(1);

    if (
      !row ||
      (auth?.type === "org" &&
        (row.job.organizationId !== auth.organizationId ||
          row.job.databaseId !== auth.databaseId))
    ) {
      throw createAppError(404, "Job not found", "NOT_FOUND");
    }
    if (row.job.status !== "running") {
      throw createAppError(409, "Job is no longer running", "JOB_NOT_RUNNING");
    }

    const metadata = isRecord(row.job.metadataJson)
      ? row.job.metadataJson
      : {};
    await db
      .update(jobs)
      .set({
        metadataJson: {
          ...metadata,
          runnerProgress: {
            stage: input.stage,
            message: input.message,
            updatedAt: new Date().toISOString(),
            ...(input.checks !== undefined
              ? { checks: input.checks }
              : isRecord(metadata.runnerProgress) &&
                  Array.isArray(metadata.runnerProgress.checks)
                ? { checks: metadata.runnerProgress.checks }
                : {}),
          },
        },
        updatedAt: new Date(),
      })
      .where(and(eq(jobs.id, jobId), eq(jobs.status, "running")));
  },

  async complete(
    jobId: string,
    input: CompleteJobInput,
    auth?: RunnerAuthContext
  ): Promise<JobResource> {
    const rows = await db
      .select({
        job: jobs,
        databaseName: databases.name,
      })
      .from(jobs)
      .innerJoin(databases, eq(databases.id, jobs.databaseId))
      .where(eq(jobs.id, jobId))
      .limit(1);

    if (!rows[0]) {
      throw createAppError(404, "Job not found", "NOT_FOUND");
    }

    if (auth?.type === "org" && rows[0].job.organizationId !== auth.organizationId) {
      throw createAppError(404, "Job not found", "NOT_FOUND");
    }

    if (rows[0].job.status !== "running" && rows[0].job.status !== "pending") {
      throw createAppError(409, "Job is already finished", "JOB_ALREADY_FINISHED");
    }

    const executionMode =
      input.executionMode ??
      rows[0].job.executionMode ??
      (auth?.type === "stub" ? "stub" : auth?.type === "org" ? auth.kind : null);

    const [updated] = await db
      .update(jobs)
      .set({
        status: input.status,
        errorMessage: input.errorMessage ?? null,
        rtoSeconds: input.rtoSeconds ?? null,
        executionMode,
        finishedAt: new Date(),
        updatedAt: new Date(),
        startedAt: rows[0].job.startedAt ?? new Date(),
      })
      .where(eq(jobs.id, jobId))
      .returning();

    if (input.results.length > 0) {
      await db.insert(jobResults).values(
        input.results.map((r) => ({
          organizationId: updated.organizationId,
          jobId: updated.id,
          checkName: r.checkName,
          checkType: r.checkType,
          status: r.status,
          message: r.message ?? null,
          durationMs: r.durationMs ?? null,
        }))
      );
    }

    return toJob(updated, rows[0].databaseName);
  },

  async cancel(organizationId: string, jobId: string): Promise<JobResource> {
    const rows = await db
      .select({
        job: jobs,
        databaseName: databases.name,
      })
      .from(jobs)
      .innerJoin(databases, eq(databases.id, jobs.databaseId))
      .where(and(eq(jobs.id, jobId), eq(jobs.organizationId, organizationId)))
      .limit(1);

    if (!rows[0]) {
      throw createAppError(404, "Job not found", "NOT_FOUND");
    }

    if (!["pending", "running"].includes(rows[0].job.status)) {
      throw createAppError(
        409,
        "Only queued or running drills can be cancelled",
        "JOB_ALREADY_FINISHED"
      );
    }

    const [updated] = await db
      .update(jobs)
      .set({
        status: "cancelled",
        errorMessage: "Cancelled from the dashboard",
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(jobs.id, jobId))
      .returning();

    return toJob(updated, rows[0].databaseName);
  },

  async listActive(organizationId: string): Promise<JobResource[]> {
    const rows = await db
      .select({
        job: jobs,
        databaseName: databases.name,
      })
      .from(jobs)
      .innerJoin(databases, eq(databases.id, jobs.databaseId))
      .where(
        and(
          eq(jobs.organizationId, organizationId),
          or(eq(jobs.status, "pending"), eq(jobs.status, "running"))
        )
      )
      .orderBy(desc(jobs.createdAt));

    return rows.map((r) => toJob(r.job, r.databaseName));
  },

  async getOrganizationId(jobId: string): Promise<string> {
    const rows = await db
      .select({ organizationId: jobs.organizationId })
      .from(jobs)
      .where(eq(jobs.id, jobId))
      .limit(1);

    if (!rows[0]) {
      throw createAppError(404, "Job not found", "NOT_FOUND");
    }

    return rows[0].organizationId;
  },
  };
}

export type JobsService = ReturnType<typeof createJobsService>;
