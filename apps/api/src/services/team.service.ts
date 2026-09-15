import { and, count, desc, eq, ne } from "drizzle-orm";
import type { Paginated, TeamMemberResource, UserRole } from "@revenant/shared";
import type { Database } from "../db/index.js";
import { organizationInvites, users } from "../db/schema.js";
import { createAppError } from "../lib/errors.js";
import { assertPlanLimit } from "../lib/plan-limits.js";
import {
  generateInviteToken,
  hashInviteToken,
} from "./auth-providers.service.js";
import type {
  InviteTeamMemberInput,
  UpdateTeamMemberInput,
} from "../validations/team.schema.js";
import {
  paginationMeta,
  paginationOffset,
  type PaginationQueryInput,
} from "../validations/pagination.schema.js";
import type { Env } from "../config/env.js";

function toMember(row: typeof users.$inferSelect): TeamMemberResource {
  return {
    id: row.id,
    email: row.email,
    role: row.role as UserRole,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function createTeamService(db: Database, env: Env) {
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
      invitedBy: string,
      input: InviteTeamMemberInput
    ): Promise<{ inviteUrl: string; email: string; role: UserRole; expiresAt: string }> {
      await assertPlanLimit(db, organizationId, "teamMembers");

      const existing = await db
        .select({ id: users.id })
        .from(users)
        .where(
          and(
            eq(users.organizationId, organizationId),
            eq(users.email, input.email.toLowerCase())
          )
        )
        .limit(1);

      if (existing[0]) {
        throw createAppError(409, "Email already exists in this organization", "CONFLICT");
      }

      const token = generateInviteToken();
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

      try {
        await db.insert(organizationInvites).values({
          organizationId,
          email: input.email.toLowerCase(),
          role: input.role,
          tokenHash: hashInviteToken(token),
          invitedBy,
          expiresAt,
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "";
        if (message.includes("unique") || message.includes("duplicate")) {
          throw createAppError(
            409,
            "An invite for this email is already pending",
            "CONFLICT"
          );
        }
        throw err;
      }

      const inviteUrl = `${env.PUBLIC_APP_URL}/login?invite=${encodeURIComponent(token)}`;

      return {
        inviteUrl,
        email: input.email.toLowerCase(),
        role: input.role,
        expiresAt: expiresAt.toISOString(),
      };
    },

    async updateRole(
      organizationId: string,
      memberId: string,
      actorId: string,
      input: UpdateTeamMemberInput
    ): Promise<TeamMemberResource> {
      if (memberId === actorId && input.role !== "admin") {
        await assertNotLastAdmin(organizationId, memberId);
      }

      const [row] = await db
        .update(users)
        .set({ role: input.role, updatedAt: new Date() })
        .where(
          and(eq(users.id, memberId), eq(users.organizationId, organizationId))
        )
        .returning();

      if (!row) {
        throw createAppError(404, "Team member not found", "NOT_FOUND");
      }

      return toMember(row);
    },

    async remove(
      organizationId: string,
      memberId: string,
      actorId: string
    ): Promise<void> {
      if (memberId === actorId) {
        throw createAppError(400, "You cannot remove yourself", "SELF_REMOVE");
      }

      await assertNotLastAdmin(organizationId, memberId);

      const [row] = await db
        .delete(users)
        .where(
          and(eq(users.id, memberId), eq(users.organizationId, organizationId))
        )
        .returning({ id: users.id });

      if (!row) {
        throw createAppError(404, "Team member not found", "NOT_FOUND");
      }
    },
  };
}

export type TeamService = ReturnType<typeof createTeamService>;
