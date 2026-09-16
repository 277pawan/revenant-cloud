import { and, desc, eq, isNull, or } from "drizzle-orm";
import type { JobResource } from "@revenant/shared";
import type { Database } from "../db/index.js";
import { databases, jobs, runners, validationPlans } from "../db/schema.js";
import { createAppError } from "../lib/errors.js";
import { assertSelfHostedAgentAllowed } from "../lib/plan-limits.js";
import { generateRunnerToken } from "../lib/runner-token.js";

export type PlanServiceResource = {
  databaseId: string;
  databaseName: string;
  planName: string;
  recoveryMode: string;
  runner: {
    id: string;
    tokenPrefix: string;
    lastSeenAt: string | null;
    kind: string;
  } | null;
  jobs: JobResource[];
};

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

export function createRunnersService(db: Database) {
  return {
    /** One row per validation plan — runner + recent jobs for that plan only. */
    async listServices(organizationId: string): Promise<PlanServiceResource[]> {
      const plans = await db
        .select({
          plan: validationPlans,
          database: databases,
          runner: runners,
        })
        .from(validationPlans)
        .innerJoin(databases, eq(databases.id, validationPlans.databaseId))
        .leftJoin(
          runners,
          and(
            eq(runners.databaseId, validationPlans.databaseId),
            eq(runners.organizationId, organizationId),
            isNull(runners.revokedAt)
          )
        )
        .where(eq(validationPlans.organizationId, organizationId))
        .orderBy(desc(validationPlans.updatedAt));

      const result: PlanServiceResource[] = [];

      for (const row of plans) {
        const jobRows = await db
          .select()
          .from(jobs)
          .where(
            and(
              eq(jobs.databaseId, row.plan.databaseId),
              eq(jobs.organizationId, organizationId)
            )
          )
          .orderBy(desc(jobs.createdAt))
          .limit(15);

        result.push({
          databaseId: row.plan.databaseId,
          databaseName: row.database.name,
          planName: row.plan.name,
          recoveryMode: row.database.recoveryMode ?? "direct",
          runner: row.runner
            ? {
                id: row.runner.id,
                tokenPrefix: row.runner.tokenPrefix,
                lastSeenAt: row.runner.lastSeenAt?.toISOString() ?? null,
                kind: row.runner.kind,
              }
            : null,
          jobs: jobRows.map((j) => toJob(j, row.database.name)),
        });
      }

      return result;
    },

    /** Issue or rotate agent token — one active runner row per plan (update in place). */
    async issueToken(
      organizationId: string,
      databaseId: string
    ): Promise<{ token: string; runnerId: string }> {
      await assertSelfHostedAgentAllowed(db, organizationId);

      const plan = await db
        .select({ name: validationPlans.name })
        .from(validationPlans)
        .where(
          and(
            eq(validationPlans.databaseId, databaseId),
            eq(validationPlans.organizationId, organizationId)
          )
        )
        .limit(1);

      if (!plan[0]) {
        throw createAppError(404, "Validation plan not found", "NOT_FOUND");
      }

      // Retire pre-migration org tokens (no database_id) so rotation does not leave ghosts.
      await db
        .update(runners)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(runners.organizationId, organizationId),
            isNull(runners.databaseId),
            isNull(runners.revokedAt)
          )
        );

      const { token, prefix, hash } = generateRunnerToken();

      const existing = await db
        .select({ id: runners.id })
        .from(runners)
        .where(
          and(
            eq(runners.organizationId, organizationId),
            eq(runners.databaseId, databaseId),
            isNull(runners.revokedAt)
          )
        )
        .limit(1);

      if (existing[0]) {
        await db
          .update(runners)
          .set({
            tokenHash: hash,
            tokenPrefix: prefix,
            name: plan[0].name,
            kind: "agent",
          })
          .where(eq(runners.id, existing[0].id));

        return { token, runnerId: existing[0].id };
      }

      const [row] = await db
        .insert(runners)
        .values({
          organizationId,
          databaseId,
          name: plan[0].name,
          kind: "agent",
          tokenHash: hash,
          tokenPrefix: prefix,
        })
        .returning();

      return { token, runnerId: row.id };
    },

    async identity(runnerId: string, organizationId: string) {
      const rows = await db
        .select({
          id: runners.id,
          name: runners.name,
          kind: runners.kind,
          databaseId: runners.databaseId,
          organizationId: runners.organizationId,
          lastSeenAt: runners.lastSeenAt,
        })
        .from(runners)
        .where(
          and(
            eq(runners.id, runnerId),
            eq(runners.organizationId, organizationId),
            isNull(runners.revokedAt)
          )
        )
        .limit(1);

      if (!rows[0] || !rows[0].databaseId) {
        throw createAppError(404, "Runner not found", "NOT_FOUND");
      }

      return {
        type: "org" as const,
        runnerId: rows[0].id,
        organizationId: rows[0].organizationId,
        databaseId: rows[0].databaseId,
        name: rows[0].name,
        kind: rows[0].kind,
        lastSeenAt: rows[0].lastSeenAt?.toISOString() ?? null,
      };
    },
  };
}

export type RunnersService = ReturnType<typeof createRunnersService>;
