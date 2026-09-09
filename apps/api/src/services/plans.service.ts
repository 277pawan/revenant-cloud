import { and, count, desc, eq } from "drizzle-orm";
import type { Paginated, ValidationPlanResource } from "@revenant/shared";
import type { Database } from "../db/index.js";
import { databases, validationPlans } from "../db/schema.js";
import { AppError } from "../lib/errors.js";
import type { UpsertValidationPlanInput } from "../validations/plans.schema.js";
import {
  paginationMeta,
  paginationOffset,
  type PaginationQueryInput,
} from "../validations/pagination.schema.js";

function toResource(
  plan: typeof validationPlans.$inferSelect,
  databaseName: string
): ValidationPlanResource {
  return {
    id: plan.id,
    databaseId: plan.databaseId,
    databaseName,
    name: plan.name,
    yamlText: plan.yamlText,
    version: plan.version,
    createdAt: plan.createdAt.toISOString(),
    updatedAt: plan.updatedAt.toISOString(),
  };
}

export class PlansService {
  constructor(private db: Database) {}

  private async assertDatabase(
    organizationId: string,
    databaseId: string
  ): Promise<{ id: string; name: string }> {
    const rows = await this.db
      .select({ id: databases.id, name: databases.name })
      .from(databases)
      .where(
        and(eq(databases.id, databaseId), eq(databases.organizationId, organizationId))
      )
      .limit(1);

    if (!rows[0]) {
      throw new AppError(404, "Database not found", "NOT_FOUND");
    }
    return rows[0];
  }

  async list(
    organizationId: string,
    pagination: PaginationQueryInput
  ): Promise<Paginated<ValidationPlanResource>> {
    const { page, pageSize } = pagination;
    const offset = paginationOffset(page, pageSize);

    const [totalRow] = await this.db
      .select({ value: count() })
      .from(validationPlans)
      .where(eq(validationPlans.organizationId, organizationId));

    const total = Number(totalRow?.value ?? 0);

    const rows = await this.db
      .select({
        plan: validationPlans,
        databaseName: databases.name,
      })
      .from(validationPlans)
      .innerJoin(databases, eq(databases.id, validationPlans.databaseId))
      .where(eq(validationPlans.organizationId, organizationId))
      .orderBy(desc(validationPlans.updatedAt))
      .limit(pageSize)
      .offset(offset);

    return {
      data: rows.map((r) => toResource(r.plan, r.databaseName)),
      pagination: paginationMeta(total, page, pageSize),
    };
  }

  async getByDatabaseId(
    organizationId: string,
    databaseId: string
  ): Promise<ValidationPlanResource> {
    const dbRow = await this.assertDatabase(organizationId, databaseId);

    const rows = await this.db
      .select()
      .from(validationPlans)
      .where(
        and(
          eq(validationPlans.databaseId, databaseId),
          eq(validationPlans.organizationId, organizationId)
        )
      )
      .limit(1);

    if (!rows[0]) {
      throw new AppError(404, "Validation plan not found", "NOT_FOUND");
    }
    return toResource(rows[0], dbRow.name);
  }

  async upsert(
    organizationId: string,
    databaseId: string,
    input: UpsertValidationPlanInput
  ): Promise<ValidationPlanResource> {
    const dbRow = await this.assertDatabase(organizationId, databaseId);

    const existing = await this.db
      .select()
      .from(validationPlans)
      .where(
        and(
          eq(validationPlans.databaseId, databaseId),
          eq(validationPlans.organizationId, organizationId)
        )
      )
      .limit(1);

    if (existing[0]) {
      const [updated] = await this.db
        .update(validationPlans)
        .set({
          name: input.name ?? existing[0].name,
          yamlText: input.yamlText,
          version: existing[0].version + 1,
          updatedAt: new Date(),
        })
        .where(eq(validationPlans.id, existing[0].id))
        .returning();
      return toResource(updated, dbRow.name);
    }

    const [created] = await this.db
      .insert(validationPlans)
      .values({
        organizationId,
        databaseId,
        name: input.name ?? "default",
        yamlText: input.yamlText,
        version: 1,
      })
      .returning();

    return toResource(created, dbRow.name);
  }

  async delete(organizationId: string, databaseId: string): Promise<void> {
    await this.assertDatabase(organizationId, databaseId);

    const deleted = await this.db
      .delete(validationPlans)
      .where(
        and(
          eq(validationPlans.databaseId, databaseId),
          eq(validationPlans.organizationId, organizationId)
        )
      )
      .returning({ id: validationPlans.id });

    if (!deleted[0]) {
      throw new AppError(404, "Validation plan not found", "NOT_FOUND");
    }
  }
}
