import { and, count, desc, eq, ne } from "drizzle-orm";
import type { Paginated, TeamMemberResource, UserRole } from "@revenant/shared";
import type { Database } from "../db/index.js";
import { users } from "../db/schema.js";
import { hashPassword } from "../lib/password.js";
import { createAppError } from "../lib/errors.js";
import type {
  InviteTeamMemberInput,
  UpdateTeamMemberInput,
} from "../validations/team.schema.js";
import {
  paginationMeta,
  paginationOffset,
  type PaginationQueryInput,
} from "../validations/pagination.schema.js";

function toMember(row: typeof users.$inferSelect): TeamMemberResource {
  return {
    id: row.id,
    email: row.email,
    role: row.role as UserRole,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function createTeamService(db: Database) {

  async function assertNotLastAdmin(organizationId: string, excludeId: string) {
    const [row] = await db
      .select({ value: count() })
      .from(users)
      .where(
        and(
          eq(users.organizationId, organizationId),
          eq(users.role, "admin"),
          ne(users.id, excludeId)
        )
      );

    if (Number(row?.value ?? 0) < 1) {
      throw createAppError(
        400,
        "Organization must keep at least one admin",
        "LAST_ADMIN"
      );
    }
  }
  return {
  async list(
    organizationId: string,
    pagination: PaginationQueryInput
  ): Promise<Paginated<TeamMemberResource>> {
    const { page, pageSize } = pagination;
    const offset = paginationOffset(page, pageSize);

    const [totalRow] = await db
      .select({ value: count() })
      .from(users)
      .where(eq(users.organizationId, organizationId));

    const total = Number(totalRow?.value ?? 0);

    const rows = await db
      .select()
      .from(users)
      .where(eq(users.organizationId, organizationId))
      .orderBy(desc(users.createdAt))
      .limit(pageSize)
      .offset(offset);

    return {
      data: rows.map(toMember),
      pagination: paginationMeta(total, page, pageSize),
    };
  },

  async invite(
    organizationId: string,
    input: InviteTeamMemberInput
  ): Promise<TeamMemberResource> {
    const passwordHash = await hashPassword(input.password);

    try {
      const [user] = await db
        .insert(users)
        .values({
          organizationId,
          email: input.email.toLowerCase(),
          passwordHash,
          role: input.role,
        })
        .returning();

      return toMember(user);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "";
      if (message.includes("unique") || message.includes("duplicate")) {
        throw createAppError(409, "Email already exists in this organization", "CONFLICT");
      }
      throw err;
    }
  },

  async updateRole(
    organizationId: string,
    memberId: string,
    actorId: string,
    input: UpdateTeamMemberInput
  ): Promise<TeamMemberResource> {
    if (memberId === actorId && input.role !== "admin") {
      throw createAppError(400, "You cannot demote your own admin role", "INVALID_ROLE_CHANGE");
    }

    const target = await db
      .select()
      .from(users)
      .where(and(eq(users.id, memberId), eq(users.organizationId, organizationId)))
      .limit(1);

    if (!target[0]) {
      throw createAppError(404, "Team member not found", "NOT_FOUND");
    }

    if (target[0].role === "admin" && input.role !== "admin") {
      await assertNotLastAdmin(organizationId, memberId);
    }

    const [updated] = await db
      .update(users)
      .set({ role: input.role, updatedAt: new Date() })
      .where(and(eq(users.id, memberId), eq(users.organizationId, organizationId)))
      .returning();

    return toMember(updated);
  },

  async remove(
    organizationId: string,
    memberId: string,
    actorId: string
  ): Promise<void> {
    if (memberId === actorId) {
      throw createAppError(400, "You cannot remove yourself", "CANNOT_REMOVE_SELF");
    }

    const target = await db
      .select()
      .from(users)
      .where(and(eq(users.id, memberId), eq(users.organizationId, organizationId)))
      .limit(1);

    if (!target[0]) {
      throw createAppError(404, "Team member not found", "NOT_FOUND");
    }

    if (target[0].role === "admin") {
      await assertNotLastAdmin(organizationId, memberId);
    }

    await db
      .delete(users)
      .where(and(eq(users.id, memberId), eq(users.organizationId, organizationId)));
  }
  };
}

export type TeamService = ReturnType<typeof createTeamService>;
