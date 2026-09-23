import { and, desc, eq } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { databases, jobs, recoveryChallenges, validationPlans } from "../db/schema.js";
import { createAppError } from "../lib/errors.js";
import { generateCorrelationId } from "../lib/observability.js";
import {
  assertSandboxConcurrency,
  assertSubscriptionActive,
} from "../lib/plan-limits.js";

export type RecoveryChallengeStrategy = "latest" | "days_ago";

export interface RecoveryChallengeResource {
  id: string;
  databaseId: string;
  name: string;
  strategy: RecoveryChallengeStrategy;
  daysAgo: number;
  enabled: boolean;
  lastRunAt: string | null;
  lastJobId: string | null;
  lastStatus: string | null;
  createdAt: string;
  updatedAt: string;
}

function toResource(row: typeof recoveryChallenges.$inferSelect): RecoveryChallengeResource {
  return {
    id: row.id,
    databaseId: row.databaseId,
    name: row.name,
    strategy: row.strategy as RecoveryChallengeStrategy,
    daysAgo: row.daysAgo,
    enabled: row.enabled === "true",
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    lastJobId: row.lastJobId,
    lastStatus: row.lastStatus,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function createRecoveryChallengesService(db: Database) {
  return {
    async list(organizationId: string, databaseId: string): Promise<RecoveryChallengeResource[]> {
      const rows = await db
        .select()
        .from(recoveryChallenges)
        .where(
          and(
            eq(recoveryChallenges.organizationId, organizationId),
            eq(recoveryChallenges.databaseId, databaseId)
          )
        )
        .orderBy(desc(recoveryChallenges.createdAt));
      return rows.map(toResource);
    },

    async create(
      organizationId: string,
      databaseId: string,
      input: { name: string; strategy: RecoveryChallengeStrategy; daysAgo?: number }
    ): Promise<RecoveryChallengeResource> {
      await assertDatabase(db, organizationId, databaseId);

      const [row] = await db
        .insert(recoveryChallenges)
        .values({
          organizationId,
          databaseId,
          name: input.name.trim(),
          strategy: input.strategy,
          daysAgo: input.strategy === "days_ago" ? Math.max(1, input.daysAgo ?? 1) : 0,
        })
        .returning();

      return toResource(row);
    },

    async update(
      organizationId: string,
      challengeId: string,
      input: Partial<{ name: string; strategy: RecoveryChallengeStrategy; daysAgo: number; enabled: boolean }>
    ): Promise<RecoveryChallengeResource> {
      const [existing] = await db
        .select()
        .from(recoveryChallenges)
        .where(
          and(
            eq(recoveryChallenges.id, challengeId),
            eq(recoveryChallenges.organizationId, organizationId)
          )
        )
        .limit(1);

      if (!existing) {
        throw createAppError(404, "Challenge not found", "NOT_FOUND");
      }

      const [row] = await db
        .update(recoveryChallenges)
        .set({
          name: input.name?.trim() ?? existing.name,
          strategy: input.strategy ?? existing.strategy,
          daysAgo:
            input.daysAgo ??
            (input.strategy === "days_ago" ? existing.daysAgo : existing.daysAgo),
          enabled:
            input.enabled === undefined
              ? existing.enabled
              : input.enabled
                ? "true"
                : "false",
          updatedAt: new Date(),
        })
        .where(eq(recoveryChallenges.id, challengeId))
        .returning();

      return toResource(row);
    },

    async remove(organizationId: string, challengeId: string): Promise<void> {
      const result = await db
        .delete(recoveryChallenges)
        .where(
          and(
            eq(recoveryChallenges.id, challengeId),
            eq(recoveryChallenges.organizationId, organizationId)
          )
        )
        .returning({ id: recoveryChallenges.id });

      if (!result[0]) {
        throw createAppError(404, "Challenge not found", "NOT_FOUND");
      }
    },

    async run(
      organizationId: string,
      userId: string,
      challengeId: string
    ): Promise<{ jobId: string }> {
      const [challenge] = await db
        .select()
        .from(recoveryChallenges)
        .where(
          and(
            eq(recoveryChallenges.id, challengeId),
            eq(recoveryChallenges.organizationId, organizationId)
          )
        )
        .limit(1);

      if (!challenge) {
        throw createAppError(404, "Challenge not found", "NOT_FOUND");
      }

      const [plan] = await db
        .select({ id: validationPlans.id })
        .from(validationPlans)
        .where(eq(validationPlans.databaseId, challenge.databaseId))
        .limit(1);

      if (!plan) {
        throw createAppError(400, "Save a validation plan before running a challenge", "NO_VALIDATION_PLAN");
      }

      await assertSubscriptionActive(db, organizationId);
      await assertSandboxConcurrency(db, organizationId);

      const correlationId = generateCorrelationId();
      const [job] = await db
        .insert(jobs)
        .values({
          organizationId,
          databaseId: challenge.databaseId,
          status: "pending",
          trigger: "challenge",
          triggeredByUserId: userId,
          correlationId,
          metadataJson: {
            challengeId: challenge.id,
            strategy: challenge.strategy,
            daysAgo: challenge.daysAgo,
          },
        })
        .returning();

      await db
        .update(recoveryChallenges)
        .set({ lastJobId: job.id, lastRunAt: new Date(), updatedAt: new Date() })
        .where(eq(recoveryChallenges.id, challenge.id));

      return { jobId: job.id };
    },
  };
}

async function assertDatabase(
  db: Database,
  organizationId: string,
  databaseId: string
) {
  const [row] = await db
    .select({ id: databases.id })
    .from(databases)
    .where(and(eq(databases.id, databaseId), eq(databases.organizationId, organizationId)))
    .limit(1);
  if (!row) throw createAppError(404, "Database not found", "NOT_FOUND");
}
