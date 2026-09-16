import type { OrgSubscriptionSummary } from "@revenant/shared";
import { getPlanDefinition } from "@revenant/shared";
import type { SubscriptionStatus } from "@revenant/shared";
import type { Database } from "../db/index.js";
import {
  countActiveRestoreDrills,
  countPlanResource,
  getOrganizationBilling,
} from "../lib/plan-limits.js";
import {
  isSubscriptionActive,
  parseOrganizationPlan,
  trialDaysRemaining,
} from "../lib/org-subscription.js";

export function createBillingService(db: Database) {
  return {
    async getSubscriptionSummary(organizationId: string): Promise<OrgSubscriptionSummary> {
      const billing = await getOrganizationBilling(db, organizationId);
      const planId = parseOrganizationPlan(billing.plan);
      const plan = getPlanDefinition(planId);

      const [workflows, schedules, teamMembers, integrations, activeRestoreDrills] =
        await Promise.all([
          countPlanResource(db, organizationId, "databases"),
          countPlanResource(db, organizationId, "schedules"),
          countPlanResource(db, organizationId, "teamMembers"),
          countPlanResource(db, organizationId, "integrations"),
          countActiveRestoreDrills(db, organizationId),
        ]);

      return {
        plan: planId,
        planName: plan.name,
        priceInr: plan.priceInr,
        priceLabel: plan.priceLabel,
        subscriptionStatus: billing.subscriptionStatus as SubscriptionStatus,
        subscriptionActive: isSubscriptionActive(billing),
        trialEndsAt: billing.trialEndsAt?.toISOString() ?? null,
        trialDaysRemaining: trialDaysRemaining(billing.trialEndsAt),
        limits: plan.limits,
        usage: {
          workflows,
          schedules,
          teamMembers,
          integrations,
          activeRestoreDrills,
        },
        features: {
          managedCloudDrills: plan.limits.managedCloudDrills,
          selfHostedAgent: plan.limits.selfHostedAgent,
          directPostgres: plan.limits.directPostgresDrills,
        },
      };
    },
  };
}

export type BillingService = ReturnType<typeof createBillingService>;
