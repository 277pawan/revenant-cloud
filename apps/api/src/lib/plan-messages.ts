import {
  getPlanDefinition,
  STARTER_PRICE_LABEL,
  STARTER_TRIAL_DAYS,
  upgradePlanTarget,
  type OrganizationPlan,
  type PlanLimitResource,
} from "@revenant/shared";
import type { OrgBillingRow } from "./org-subscription.js";
import { trialDaysRemaining } from "./org-subscription.js";

function upgradeHint(current: OrganizationPlan): string {
  const next = upgradePlanTarget(current);
  if (!next) return "Contact us for Enterprise.";
  const nextPlan = getPlanDefinition(next);
  return `Upgrade to ${nextPlan.name} (${nextPlan.priceLabel}) for more.`;
}

export function messageSubscriptionInactive(billing: OrgBillingRow): string {
  const plan = getPlanDefinition(
    billing.plan === "pro" || billing.plan === "enterprise" ? billing.plan : "starter"
  );
  if (billing.subscriptionStatus === "past_due") {
    return `Your ${plan.name} payment is past due. Update billing on the website to resume restore drills.`;
  }
  if (billing.subscriptionStatus === "canceled") {
    return `Your ${plan.name} subscription was canceled. Resubscribe on the website to run cloud drills again.`;
  }
  return (
    `Your ${STARTER_TRIAL_DAYS}-day ${plan.name} trial has ended. ` +
    `Subscribe for ${plan.priceLabel ?? STARTER_PRICE_LABEL} on the website to keep managed restore drills, ` +
    `or use the free Developer CLI in your own pipeline (no cloud account).`
  );
}

export function messageWorkflowLimit(planId: OrganizationPlan, limit: number): string {
  const plan = getPlanDefinition(planId);
  return (
    `${plan.name} includes ${limit} production workflow${limit === 1 ? "" : "s"}. ` +
    `${upgradeHint(planId)}`
  );
}

export function messageScheduleLimit(planId: OrganizationPlan, limit: number): string {
  const plan = getPlanDefinition(planId);
  return (
    `${plan.name} includes ${limit} scheduled drill${limit === 1 ? "" : "s"}. ` +
    `${upgradeHint(planId)}`
  );
}

export function messageTeamLimit(planId: OrganizationPlan, limit: number): string {
  const plan = getPlanDefinition(planId);
  return (
    `${plan.name} includes up to ${limit} team members. ` +
    `${upgradeHint(planId)}`
  );
}

export function messageIntegrationsBlocked(planId: OrganizationPlan): string {
  const plan = getPlanDefinition(planId);
  return (
    `${plan.name} does not include Slack or HTTP integrations. ` +
    `${upgradeHint(planId)}`
  );
}

export function messageParallelDrillLimit(planId: OrganizationPlan, limit: number): string {
  const plan = getPlanDefinition(planId);
  if (limit === 1) {
    return (
      `${plan.name} runs one restore drill at a time. ` +
      `Wait for the current drill to finish, then try again.`
    );
  }
  return (
    `${plan.name} allows ${limit} restore drills at the same time. ` +
    `Wait for a drill to finish or ${upgradeHint(planId).toLowerCase()}`
  );
}

export function messageDirectPostgresBlocked(planId: OrganizationPlan): string {
  const plan = getPlanDefinition(planId);
  return (
    `${plan.name} uses managed AWS snapshot drills only (Revenant runs them — no Docker). ` +
    `Upgrade to Pro for private-network Postgres, or use the free Developer CLI in CI.`
  );
}

export function messageSelfHostedAgentBlocked(planId: OrganizationPlan): string {
  const plan = getPlanDefinition(planId);
  return (
    `${plan.name} uses fully managed drills — no agent setup needed. ` +
    `Run drills from Workflows. Upgrade to Pro only if Postgres is inside a private VPC.`
  );
}

export function messageAwsDrillsBlocked(): string {
  return "AWS restore drills are not included on this plan.";
}

export function messagePlanLimit(
  planId: OrganizationPlan,
  resource: PlanLimitResource,
  limit: number
): string {
  switch (resource) {
    case "databases":
      return messageWorkflowLimit(planId, limit);
    case "schedules":
      return messageScheduleLimit(planId, limit);
    case "teamMembers":
      return messageTeamLimit(planId, limit);
    default:
      return messageIntegrationsBlocked(planId);
  }
}

export function messageTrialWelcome(planId: OrganizationPlan, trialEndsAt: Date): string {
  const plan = getPlanDefinition(planId);
  const days = trialDaysRemaining(trialEndsAt);
  return (
    `Welcome to ${plan.name}. ` +
    `You have ${days ?? STARTER_TRIAL_DAYS} days free, then ${plan.priceLabel ?? STARTER_PRICE_LABEL}.`
  );
}
