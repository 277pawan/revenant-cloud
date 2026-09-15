import { and, desc, eq, sql } from "drizzle-orm";
import type { ScheduleResource } from "@revenant/shared";
import type { Database } from "../db/index.js";
import { databases, schedules, validationPlans } from "../db/schema.js";
import { computeNextRunAt } from "../lib/cron.js";
import { createAppError } from "../lib/errors.js";
import { assertPlanLimit } from "../lib/plan-limits.js";
import {
  paginationMeta,
  paginationOffset,
  type PaginationQueryInput,
} from "../validations/pagination.schema.js";

function toResource(
  row: typeof schedules.$inferSelect,
  databaseName: string
): ScheduleResource {
  return {
    id: row.id,
    databaseId: row.databaseId,
    databaseName,
    name: row.name,
    cronExpression: row.cronExpression,
    timezone: row.timezone,
    enabled: row.enabled === "true",
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    nextRunAt: row.nextRunAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function createSchedulesService(db: Database) {
  return {
    async list(organizationId: string, pagination: PaginationQueryInput) {
      const { page, pageSize } = pagination;
      const offset = paginationOffset(page, pageSize);

      const [rows, countRow] = await Promise.all([
        db
          .select({ schedule: schedules, database: databases })
          .from(schedules)
          .innerJoin(databases, eq(databases.id, schedules.databaseId))
          .where(eq(schedules.organizationId, organizationId))
          .orderBy(desc(schedules.updatedAt))
          .limit(pageSize)
          .offset(offset),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(schedules)
          .where(eq(schedules.organizationId, organizationId)),
      ]);

      const total = countRow[0]?.count ?? 0;
      return {
        data: rows.map((r) => toResource(r.schedule, r.database.name)),
        pagination: paginationMeta(total, page, pageSize),
      };
    },

    async create(
      organizationId: string,
      input: {
        databaseId: string;
        name: string;
        cronExpression: string;
        timezone: string;
        enabled: boolean;
      }
    ) {
      await assertPlanLimit(db, organizationId, "schedules");

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
          "Save a validation plan before scheduling",
          "NO_VALIDATION_PLAN"
        );
      }

      const existing = await db
        .select({ id: schedules.id })
        .from(schedules)
        .where(
          and(
            eq(schedules.databaseId, input.databaseId),
            eq(schedules.organizationId, organizationId)
          )
        )
        .limit(1);

      if (existing[0]) {
        throw createAppError(
          409,
          "Schedule already exists for this workflow",
          "SCHEDULE_EXISTS"
        );
      }

      const nextRunAt = input.enabled
        ? computeNextRunAt(input.cronExpression, input.timezone)
        : null;

      const [row] = await db
        .insert(schedules)
        .values({
          organizationId,
          databaseId: input.databaseId,
          name: input.name,
          cronExpression: input.cronExpression,
          timezone: input.timezone,
          enabled: input.enabled ? "true" : "false",
          nextRunAt,
        })
        .returning();

      const dbRow = await db
        .select({ name: databases.name })
        .from(databases)
        .where(eq(databases.id, input.databaseId))
        .limit(1);

      return toResource(row, dbRow[0]?.name ?? "");
    },

    async update(
      organizationId: string,
      id: string,
      input: {
        name?: string;
        cronExpression?: string;
        timezone?: string;
        enabled?: boolean;
      }
    ) {
      const patch: Partial<typeof schedules.$inferInsert> = {
        updatedAt: new Date(),
      };
      if (input.name !== undefined) patch.name = input.name;
      if (input.cronExpression !== undefined)
        patch.cronExpression = input.cronExpression;
      if (input.timezone !== undefined) patch.timezone = input.timezone;
      if (input.enabled !== undefined)
        patch.enabled = input.enabled ? "true" : "false";

      const existing = await db
        .select()
        .from(schedules)
        .where(
          and(eq(schedules.id, id), eq(schedules.organizationId, organizationId))
        )
        .limit(1);

      if (!existing[0]) {
        throw createAppError(404, "Schedule not found", "NOT_FOUND");
      }

      const cronExpression =
        input.cronExpression ?? existing[0].cronExpression;
      const timezone = input.timezone ?? existing[0].timezone;
      const enabled =
        input.enabled !== undefined
          ? input.enabled
          : existing[0].enabled === "true";

      patch.nextRunAt = enabled
        ? computeNextRunAt(cronExpression, timezone)
        : null;

      const [row] = await db
        .update(schedules)
        .set(patch)
        .where(
          and(eq(schedules.id, id), eq(schedules.organizationId, organizationId))
        )
        .returning();

      if (!row) {
        throw createAppError(404, "Schedule not found", "NOT_FOUND");
      }

      const dbRow = await db
        .select({ name: databases.name })
        .from(databases)
        .where(eq(databases.id, row.databaseId))
        .limit(1);

      return toResource(row, dbRow[0]?.name ?? "");
    },

    async remove(organizationId: string, id: string) {
      const [row] = await db
        .delete(schedules)
        .where(
          and(eq(schedules.id, id), eq(schedules.organizationId, organizationId))
        )
        .returning({ id: schedules.id });

      if (!row) {
        throw createAppError(404, "Schedule not found", "NOT_FOUND");
      }
    },
  };
}

export type SchedulesService = ReturnType<typeof createSchedulesService>;
