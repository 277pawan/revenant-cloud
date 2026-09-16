import type { OrganizationPlan, PlanLimits, SubscriptionStatus } from "./plans.js";

/** API countable resources (`databases` table = production workflows). */
export type PlanLimitResource = "databases" | "schedules" | "teamMembers" | "integrations";

/** Authenticated org billing snapshot for dashboard / settings */
export interface OrgSubscriptionSummary {
  plan: OrganizationPlan;
  planName: string;
  priceInr: number | null;
  priceLabel: string;
  subscriptionStatus: SubscriptionStatus;
  subscriptionActive: boolean;
  trialEndsAt: string | null;
  trialDaysRemaining: number | null;
  limits: PlanLimits;
  usage: {
    workflows: number;
    schedules: number;
    teamMembers: number;
    integrations: number;
    activeRestoreDrills: number;
  };
  features: {
    managedCloudDrills: boolean;
    selfHostedAgent: boolean;
    directPostgres: boolean;
  };
}
