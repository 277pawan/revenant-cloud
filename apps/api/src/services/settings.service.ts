import { eq } from "drizzle-orm";
import type { OrganizationSettingsResource, UpdateOrganizationRequest } from "@revenant/shared";
import type { Database } from "../db/index.js";
import { organizations } from "../db/schema.js";
import { createAppError } from "../lib/errors.js";
import { parseOrganizationPlan } from "../lib/org-subscription.js";
import type { SubscriptionStatus } from "@revenant/shared";

export function createSettingsService(db: Database) {
  return {
    async getOrganization(organizationId: string): Promise<OrganizationSettingsResource> {
      const [row] = await db
        .select()
        .from(organizations)
        .where(eq(organizations.id, organizationId))
        .limit(1);

      if (!row) {
        throw createAppError(404, "Organization not found", "NOT_FOUND");
      }

      return {
        id: row.id,
        name: row.name,
        plan: parseOrganizationPlan(row.plan),
        subscriptionStatus: row.subscriptionStatus as SubscriptionStatus,
        trialEndsAt: row.trialEndsAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      };
    },

    async updateOrganization(
      organizationId: string,
      input: UpdateOrganizationRequest
    ): Promise<OrganizationSettingsResource> {
      const [row] = await db
        .update(organizations)
        .set({
          name: input.name,
          updatedAt: new Date(),
        })
        .where(eq(organizations.id, organizationId))
        .returning();

      if (!row) {
        throw createAppError(404, "Organization not found", "NOT_FOUND");
      }

      return {
        id: row.id,
        name: row.name,
        plan: parseOrganizationPlan(row.plan),
        subscriptionStatus: row.subscriptionStatus as SubscriptionStatus,
        trialEndsAt: row.trialEndsAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      };
    },
  };
}

export type SettingsService = ReturnType<typeof createSettingsService>;
