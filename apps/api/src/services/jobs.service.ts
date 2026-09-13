import { and, count, desc, eq } from "drizzle-orm";
import type {
  JobDetailResource,
  JobResource,
  JobResultResource,
  Paginated,
} from "@revenant/shared";
import type { Database } from "../db/index.js";
import {
  databaseAwsCredentials,
  databaseCredentials,
  databases,
  jobResults,
  jobs,
  validationPlans,
} from "../db/schema.js";
import { decryptSecret } from "../lib/crypto.js";
import { createAppError } from "../lib/errors.js";
import type { RunnerAuthContext } from "../middleware/runner.js";
import type { CompleteJobInput, CreateJobInput } from "../validations/jobs.schema.js";
import {
  paginationMeta,
  paginationOffset,
  type PaginationQueryInput,
} from "../validations/pagination.schema.js";

function toJob(
  row: typeof jobs.$inferSelect,
  databaseName: string
): JobResource {
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
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
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
    pagination: PaginationQueryInput
  ): Promise<Paginated<JobResource>> {
    const { page, pageSize } = pagination;
    const offset = paginationOffset(page, pageSize);

    const [totalRow] = await db
      .select({ value: count() })
      .from(jobs)
      .where(eq(jobs.organizationId, organizationId));

    const total = Number(totalRow?.value ?? 0);

    const rows = await db
      .select({
        job: jobs,
        databaseName: databases.name,
      })
      .from(jobs)
      .innerJoin(databases, eq(databases.id, jobs.databaseId))
      .where(eq(jobs.organizationId, organizationId))
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

    const [job] = await db
      .insert(jobs)
      .values({
        organizationId,
        databaseId: input.databaseId,
        status: "pending",
        trigger: input.drillKind === "verify" ? "manual" : "full-drill",
        triggeredByUserId: userId,
      })
      .returning();

    return toJob(job, dbRows[0].name);
  },

  /**
   * Claim next pending job for this runner's validation plan (database).
   * Org agent only sees jobs for its database — not org-wide first-come-first-served.
   */
  async claimNext(auth: RunnerAuthContext) {
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

    let awsCredentials: { accessKeyId: string; secretAccessKey: string } | null =
      null;
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
        };
        if (parsed.accessKeyId && parsed.secretAccessKey) {
          awsCredentials = {
            accessKeyId: parsed.accessKeyId,
            secretAccessKey: parsed.secretAccessKey,
          };
        }
      }
    }

    const plan = await db
      .select()
      .from(validationPlans)
      .where(eq(validationPlans.databaseId, database.id))
      .limit(1);

    const recoveryMode = database.recoveryMode === "aws-rds" ? "aws-rds" : "direct";
    const recovery =
      recoveryMode === "aws-rds" && database.rdsSourceIdentifier && database.region
        ? {
            engine: "aws-rds" as const,
            sourceIdentifier: database.rdsSourceIdentifier,
            region: database.region,
            useFreetier: database.recoveryUseFreetier === "true",
            sandboxInstanceClass: database.recoverySandboxInstanceClass,
          }
        : null;

    return {
      job: toJob(updated, database.name),
      database: {
        id: database.id,
        name: database.name,
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
      executionMode,
      fullDrill:
        updated.trigger === "full-drill" ||
        (recoveryMode === "aws-rds" && updated.trigger === "schedule"),
    };
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
