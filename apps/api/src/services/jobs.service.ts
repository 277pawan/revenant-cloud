import { and, count, desc, eq } from "drizzle-orm";
import type {
  JobDetailResource,
  JobResource,
  JobResultResource,
  Paginated,
} from "@revenant/shared";
import type { Database } from "../db/index.js";
import {
  databaseCredentials,
  databases,
  jobResults,
  jobs,
  validationPlans,
} from "../db/schema.js";
import { decryptSecret } from "../lib/crypto.js";
import { AppError } from "../lib/errors.js";
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

export class JobsService {
  constructor(
    private db: Database,
    private masterKey: string
  ) {}

  async list(
    organizationId: string,
    pagination: PaginationQueryInput
  ): Promise<Paginated<JobResource>> {
    const { page, pageSize } = pagination;
    const offset = paginationOffset(page, pageSize);

    const [totalRow] = await this.db
      .select({ value: count() })
      .from(jobs)
      .where(eq(jobs.organizationId, organizationId));

    const total = Number(totalRow?.value ?? 0);

    const rows = await this.db
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
  }

  async getById(organizationId: string, id: string): Promise<JobDetailResource> {
    const rows = await this.db
      .select({
        job: jobs,
        databaseName: databases.name,
      })
      .from(jobs)
      .innerJoin(databases, eq(databases.id, jobs.databaseId))
      .where(and(eq(jobs.id, id), eq(jobs.organizationId, organizationId)))
      .limit(1);

    if (!rows[0]) {
      throw new AppError(404, "Job not found", "NOT_FOUND");
    }

    const results = await this.db
      .select()
      .from(jobResults)
      .where(eq(jobResults.jobId, id))
      .orderBy(jobResults.createdAt);

    return {
      ...toJob(rows[0].job, rows[0].databaseName),
      results: results.map(toResult),
    };
  }

  async create(
    organizationId: string,
    userId: string,
    input: CreateJobInput
  ): Promise<JobResource> {
    const dbRows = await this.db
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
      throw new AppError(404, "Database not found", "NOT_FOUND");
    }

    const [job] = await this.db
      .insert(jobs)
      .values({
        organizationId,
        databaseId: input.databaseId,
        status: "pending",
        trigger: "manual",
        triggeredByUserId: userId,
      })
      .returning();

    return toJob(job, dbRows[0].name);
  }

  /**
   * Claim next pending job for the runner.
   * Returns decrypted password + plan yaml for execution (never via public UI APIs).
   */
  async claimNext() {
    const pending = await this.db
      .select({
        job: jobs,
        database: databases,
      })
      .from(jobs)
      .innerJoin(databases, eq(databases.id, jobs.databaseId))
      .where(eq(jobs.status, "pending"))
      .orderBy(jobs.createdAt)
      .limit(1);

    if (!pending[0]) {
      return null;
    }

    const { job, database } = pending[0];

    const [updated] = await this.db
      .update(jobs)
      .set({
        status: "running",
        startedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(jobs.id, job.id), eq(jobs.status, "pending")))
      .returning();

    if (!updated) {
      // Lost race — another runner claimed it
      return null;
    }

    const cred = await this.db
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
        this.masterKey
      );
    }

    const plan = await this.db
      .select()
      .from(validationPlans)
      .where(eq(validationPlans.databaseId, database.id))
      .limit(1);

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
      },
      password,
      planYaml: plan[0]?.yamlText ?? null,
      planVersion: plan[0]?.version ?? null,
    };
  }

  async complete(jobId: string, input: CompleteJobInput): Promise<JobResource> {
    const rows = await this.db
      .select({
        job: jobs,
        databaseName: databases.name,
      })
      .from(jobs)
      .innerJoin(databases, eq(databases.id, jobs.databaseId))
      .where(eq(jobs.id, jobId))
      .limit(1);

    if (!rows[0]) {
      throw new AppError(404, "Job not found", "NOT_FOUND");
    }

    if (rows[0].job.status !== "running" && rows[0].job.status !== "pending") {
      throw new AppError(409, "Job is already finished", "JOB_ALREADY_FINISHED");
    }

    const [updated] = await this.db
      .update(jobs)
      .set({
        status: input.status,
        errorMessage: input.errorMessage ?? null,
        rtoSeconds: input.rtoSeconds ?? null,
        finishedAt: new Date(),
        updatedAt: new Date(),
        startedAt: rows[0].job.startedAt ?? new Date(),
      })
      .where(eq(jobs.id, jobId))
      .returning();

    if (input.results.length > 0) {
      await this.db.insert(jobResults).values(
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
  }
}
