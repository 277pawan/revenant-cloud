import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import type { AuditEventResource } from "@revenant/shared";
import type { Database } from "../db/index.js";
import { auditEvents } from "../db/schema.js";
import {
  paginationMeta,
  paginationOffset,
  type ListSearchQueryInput,
} from "../validations/pagination.schema.js";

function toResource(row: typeof auditEvents.$inferSelect): AuditEventResource {
  return {
    id: row.id,
    actorUserId: row.actorUserId,
    action: row.action,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
    createdAt: row.createdAt.toISOString(),
  };
}

export function createAuditService(db: Database) {
  return {
    async log(input: {
      organizationId: string;
      actorUserId: string | null;
      action: string;
      resourceType: string;
      resourceId: string;
      metadata?: Record<string, unknown>;
    }) {
      await db.insert(auditEvents).values({
        organizationId: input.organizationId,
        actorUserId: input.actorUserId,
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        metadata: input.metadata ? JSON.stringify(input.metadata) : null,
      });
    },

    async list(organizationId: string, query: ListSearchQueryInput) {
      const { page, pageSize, search } = query;
      const offset = paginationOffset(page, pageSize);

      const conditions = [eq(auditEvents.organizationId, organizationId)];
      if (search) {
        const term = `%${search}%`;
        conditions.push(
          or(
            ilike(auditEvents.action, term),
            ilike(auditEvents.resourceType, term),
            ilike(auditEvents.resourceId, term),
            ilike(auditEvents.metadata, term),
            sql`cast(${auditEvents.id} as text) ilike ${term}`,
            sql`cast(${auditEvents.actorUserId} as text) ilike ${term}`
          )!
        );
      }
      const whereClause = and(...conditions);

      const [rows, countRow] = await Promise.all([
        db
          .select()
          .from(auditEvents)
          .where(whereClause)
          .orderBy(desc(auditEvents.createdAt))
          .limit(pageSize)
          .offset(offset),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(auditEvents)
          .where(whereClause),
      ]);

      const total = countRow[0]?.count ?? 0;
      return {
        data: rows.map(toResource),
        pagination: paginationMeta(total, page, pageSize),
      };
    },
  };
}

export type AuditService = ReturnType<typeof createAuditService>;
