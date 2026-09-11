import { and, count, desc, eq, isNull } from "drizzle-orm";
import type { Paginated } from "@revenant/shared";
import type { Database } from "../db/index.js";
import { runners } from "../db/schema.js";
import { createAppError } from "../lib/errors.js";
import { generateRunnerToken } from "../lib/runner-token.js";
import {
  paginationMeta,
  paginationOffset,
  type PaginationQueryInput,
} from "../validations/pagination.schema.js";

export type RunnerResource = {
  id: string;
  name: string;
  kind: string;
  tokenPrefix: string;
  lastSeenAt: string | null;
  createdAt: string;
  revokedAt: string | null;
};

export function createRunnersService(db: Database) {
  return {
  async list(
    organizationId: string,
    pagination: PaginationQueryInput
  ): Promise<Paginated<RunnerResource>> {
    const { page, pageSize } = pagination;
    const offset = paginationOffset(page, pageSize);

    const [totalRow] = await db
      .select({ value: count() })
      .from(runners)
      .where(
        and(eq(runners.organizationId, organizationId), isNull(runners.revokedAt))
      );

    const total = Number(totalRow?.value ?? 0);

    const rows = await db
      .select()
      .from(runners)
      .where(
        and(eq(runners.organizationId, organizationId), isNull(runners.revokedAt))
      )
      .orderBy(desc(runners.createdAt))
      .limit(pageSize)
      .offset(offset);

    return {
      data: rows.map((r) => ({
        id: r.id,
        name: r.name,
        kind: r.kind,
        tokenPrefix: r.tokenPrefix,
        lastSeenAt: r.lastSeenAt?.toISOString() ?? null,
        createdAt: r.createdAt.toISOString(),
        revokedAt: r.revokedAt?.toISOString() ?? null,
      })),
      pagination: paginationMeta(total, page, pageSize),
    };
  },

  async create(
    organizationId: string,
    input: { name: string; kind: "agent" | "ci" }
  ): Promise<RunnerResource & { token: string }> {
    const { token, prefix, hash } = generateRunnerToken();

    const [row] = await db
      .insert(runners)
      .values({
        organizationId,
        name: input.name,
        kind: input.kind,
        tokenHash: hash,
        tokenPrefix: prefix,
      })
      .returning();

    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      tokenPrefix: row.tokenPrefix,
      lastSeenAt: null,
      createdAt: row.createdAt.toISOString(),
      revokedAt: null,
      token, // shown once
    };
  },

  async revoke(organizationId: string, id: string): Promise<void> {
    const updated = await db
      .update(runners)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(runners.id, id),
          eq(runners.organizationId, organizationId),
          isNull(runners.revokedAt)
        )
      )
      .returning({ id: runners.id });

    if (!updated[0]) {
      throw createAppError(404, "Runner not found", "NOT_FOUND");
    }
  }
  };
}

export type RunnersService = ReturnType<typeof createRunnersService>;
