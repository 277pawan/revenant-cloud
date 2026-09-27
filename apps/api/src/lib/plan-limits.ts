import { and, count, eq, inArray, lt, or, sql } from "drizzle-orm";
import {
  getPlanDefinition,
  type OrganizationPlan,
  type PlanLimitResource,
} from "@revenant/shared";
import type { Database } from "../db/index.js";
import { databases, jobs, organizations, schedules, users, webhookEndpoints } from "../db/schema.js";
import { createAppError } from "./errors.js";
import {
  messageAwsDrillsBlocked,
  messageDirectPostgresBlocked,
  messageIntegrationsBlocked,
  messageParallelDrillLimit,
  messagePlanLimit,
  messageSelfHostedAgentBlocked,
  messageSubscriptionInactive,
} from "./plan-messages.js";
import { isSubscriptionActive, parseOrganizationPlan, type OrgBillingRow } from "./org-subscription.js";

export async function getOrganizationBilling(
  db: Database,
  organizationId: string
): Promise<OrgBillingRow & { organizationId: string }> {
  const [row] = await db
    .select({
      organizationId: organizations.id,
      plan: organizations.plan,
      subscriptionStatus: organizations.subscriptionStatus,
      trialEndsAt: organizations.trialEndsAt,
    })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);

  if (!row) {
    throw createAppError(404, "Organization not found", "NOT_FOUND");
  }
  return row;
}

export async function getOrganizationPlan(
  db: Database,
  organizationId: string
): Promise<OrganizationPlan> {
  const row = await getOrganizationBilling(db, organizationId);
  return parseOrganizationPlan(row.plan);
}

export async function assertSubscriptionActive(
  db: Database,
  organizationId: string
): Promise<void> {
  const billing = await getOrganizationBilling(db, organizationId);
  if (!isSubscriptionActive(billing)) {
    throw createAppError(403, messageSubscriptionInactive(billing), "SUBSCRIPTION_INACTIVE");
  }
}

export async function countPlanResource(
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

const PENDING_STALE_MS = 30 * 60 * 1000;
const RUNNING_STALE_MS = 2 * 60 * 60 * 1000;

/** Fail drills stuck in queue or execution — frees Starter's one-at-a-time slot. */
export async function reapStaleRestoreDrills(
  db: Database,
  organizationId: string
): Promise<number> {
  const pendingCutoff = new Date(Date.now() - PENDING_STALE_MS);
  const runningCutoff = new Date(Date.now() - RUNNING_STALE_MS);
  const now = new Date();

  const pending = await db
    .update(jobs)
    .set({
      status: "error",
      errorMessage:
        "No runner picked up this drill within 30 minutes. Start the Revenant agent (Settings → Runners) or enable the embedded API runner, then try again.",
      finishedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(jobs.organizationId, organizationId),
        eq(jobs.status, "pending"),
        lt(jobs.createdAt, pendingCutoff)
      )
    )
    .returning({ id: jobs.id });

  const running = await db
    .update(jobs)
    .set({
      status: "error",
      errorMessage: "Drill timed out after 2 hours without finishing.",
      finishedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(jobs.organizationId, organizationId),
        eq(jobs.status, "running"),
        or(
          lt(jobs.startedAt, runningCutoff),
          and(sql`${jobs.startedAt} is null`, lt(jobs.createdAt, runningCutoff))
        )
      )
    )
    .returning({ id: jobs.id });

  return pending.length + running.length;
}

/** Pending/running restore drills (org-wide cap). */
export async function countActiveRestoreDrills(
  db: Database,
  organizationId: string
): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(jobs)
    .where(
      and(
        eq(jobs.organizationId, organizationId),
        inArray(jobs.status, ["pending", "running"])
      )
    );
  return Number(row?.value ?? 0);
}

export async function listActiveRestoreDrills(
  db: Database,
  organizationId: string
) {
  return db
    .select({
      id: jobs.id,
      databaseId: jobs.databaseId,
      status: jobs.status,
      trigger: jobs.trigger,
      createdAt: jobs.createdAt,
      databaseName: databases.name,
    })
    .from(jobs)
    .innerJoin(databases, eq(databases.id, jobs.databaseId))
    .where(
      and(
        eq(jobs.organizationId, organizationId),
        inArray(jobs.status, ["pending", "running"])
      )
    )
    .orderBy(jobs.createdAt);
}

export async function assertParallelRestoreDrills(
  db: Database,
  organizationId: string
): Promise<void> {
  const planId = await getOrganizationPlan(db, organizationId);
  const plan = getPlanDefinition(planId);
  const limit = plan.limits.parallelRestoreDrills;
  if (limit == null) return;

  await reapStaleRestoreDrills(db, organizationId);

  const active = await countActiveRestoreDrills(db, organizationId);
  if (active >= limit) {
    const blockers = await listActiveRestoreDrills(db, organizationId);
    const hint = blockers[0]
      ? ` Queued drill: ${blockers[0].databaseName} (${blockers[0].status}, run ${blockers[0].id.slice(0, 8)}…). Cancel it from the run page or wait for your agent to finish.`
      : "";
    throw createAppError(
      403,
      messageParallelDrillLimit(planId, limit) + hint,
      "PLAN_LIMIT"
    );
  }
}

/** @deprecated Use assertParallelRestoreDrills */
export const assertSandboxConcurrency = assertParallelRestoreDrills;

export async function assertSelfHostedAgentAllowed(
  db: Database,
  organizationId: string
): Promise<void> {
  const planId = await getOrganizationPlan(db, organizationId);
  const plan = getPlanDefinition(planId);
  if (!plan.limits.selfHostedAgent) {
    throw createAppError(
      403,
      messageSelfHostedAgentBlocked(planId),
      "PLAN_LIMIT"
    );
  }
}

export async function assertRecoveryModeAllowed(
  db: Database,
  organizationId: string,
  recoveryMode: string
): Promise<void> {
  const planId = await getOrganizationPlan(db, organizationId);
  const plan = getPlanDefinition(planId);
  if (recoveryMode === "direct" && !plan.limits.directPostgresDrills) {
    throw createAppError(
      403,
      messageDirectPostgresBlocked(planId),
      "PLAN_LIMIT"
    );
  }
  if (recoveryMode === "aws-rds" && !plan.limits.awsRestoreDrills) {
    throw createAppError(403, messageAwsDrillsBlocked(), "PLAN_LIMIT");
  }
}

function limitForResource(
  plan: ReturnType<typeof getPlanDefinition>,
  resource: PlanLimitResource
): number | null {
  switch (resource) {
    case "databases":
      return plan.limits.workflows;
    case "schedules":
      return plan.limits.schedules;
    case "teamMembers":
      return plan.limits.teamMembers;
    default:
      return null;
  }
}

export async function assertPlanLimit(
  db: Database,
  organizationId: string,
  resource: PlanLimitResource
): Promise<void> {
  const planId = await getOrganizationPlan(db, organizationId);
  const plan = getPlanDefinition(planId);

  if (resource === "integrations" && !plan.limits.integrations) {
    throw createAppError(
      403,
      messageIntegrationsBlocked(planId),
      "PLAN_LIMIT"
    );
  }

  const limit = limitForResource(plan, resource);
  if (limit == null) return;

  const current = await countPlanResource(db, organizationId, resource);
  if (current >= limit) {
    throw createAppError(
      403,
      messagePlanLimit(planId, resource, limit),
      "PLAN_LIMIT"
    );
  }
}
