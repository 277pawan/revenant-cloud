import { count, eq } from "drizzle-orm";
import { getPlanDefinition, type OrganizationPlan } from "@revenant/shared";
import type { Database } from "../db/index.js";
import { databases, organizations, schedules, users, webhookEndpoints } from "../db/schema.js";
import { createAppError } from "./errors.js";

export type PlanLimitResource =
  | "databases"
  | "schedules"
  | "teamMembers"
  | "integrations";

export async function getOrganizationPlan(
  db: Database,
  organizationId: string
): Promise<OrganizationPlan> {
  const [row] = await db
    .select({ plan: organizations.plan })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  return (row?.plan ?? "starter") as OrganizationPlan;
}

async function countResource(
  db: Database,
  organizationId: string,
  resource: PlanLimitResource
): Promise<number> {
  switch (resource) {
    case "databases": {
      const [row] = await db
        .select({ value: count() })
        .from(databases)
        .where(eq(databases.organizationId, organizationId));
      return Number(row?.value ?? 0);
    }
    case "schedules": {
      const [row] = await db
        .select({ value: count() })
        .from(schedules)
        .where(eq(schedules.organizationId, organizationId));
      return Number(row?.value ?? 0);
    }
    case "teamMembers": {
      const [row] = await db
        .select({ value: count() })
        .from(users)
        .where(eq(users.organizationId, organizationId));
      return Number(row?.value ?? 0);
    }
    case "integrations": {
      const [row] = await db
        .select({ value: count() })
        .from(webhookEndpoints)
        .where(eq(webhookEndpoints.organizationId, organizationId));
      return Number(row?.value ?? 0);
    }
    default:
      return 0;
  }
}

export async function assertPlanLimit(
  db: Database,
  organizationId: string,
  resource: PlanLimitResource
): Promise<void> {
  const plan = getPlanDefinition(await getOrganizationPlan(db, organizationId));

  if (resource === "integrations" && !plan.limits.integrations) {
    throw createAppError(
      403,
      `${plan.name} plan does not include Slack, email, or HTTP integrations. Upgrade to Pro.`,
      "PLAN_LIMIT"
    );
  }

  const limit =
    resource === "integrations" ? null : plan.limits[resource as keyof typeof plan.limits];

  if (limit == null || typeof limit !== "number") return;

  const current = await countResource(db, organizationId, resource);
  if (current >= limit) {
    const labels: Record<PlanLimitResource, string> = {
      databases: "database workflows",
      schedules: "schedules",
      teamMembers: "team members",
      integrations: "integrations",
    };
    throw createAppError(
      403,
      `${plan.name} plan allows up to ${limit} ${labels[resource]}. Upgrade to add more.`,
      "PLAN_LIMIT"
    );
  }
}
