import type { OrganizationPlan, SubscriptionStatus } from "@revenant/shared";
import { STARTER_TRIAL_DAYS } from "@revenant/shared";

export type OrgBillingRow = {
  plan: string;
  subscriptionStatus: string;
  trialEndsAt: Date | null;
};

export function trialEndsAtFromNow(days = STARTER_TRIAL_DAYS): Date {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

export function isSubscriptionActive(row: OrgBillingRow): boolean {
  const status = row.subscriptionStatus as SubscriptionStatus;
  if (status === "active") return true;
  if (status === "trialing" && row.trialEndsAt) {
    return row.trialEndsAt.getTime() > Date.now();
  }
  return false;
}

export function subscriptionLabel(row: OrgBillingRow): string {
  if (isSubscriptionActive(row)) {
    if (row.subscriptionStatus === "trialing" && row.trialEndsAt) {
      const days = Math.max(
        0,
        Math.ceil((row.trialEndsAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000))
      );
      return days > 0 ? `Trial · ${days} day${days === 1 ? "" : "s"} left` : "Trial ending";
    }
    return "Active";
  }
  return "Trial ended — upgrade to continue";
}

export function parseOrganizationPlan(plan: string): OrganizationPlan {
  if (plan === "pro" || plan === "enterprise") return plan;
  return "starter";
}

export function trialDaysRemaining(trialEndsAt: Date | null): number | null {
  if (!trialEndsAt) return null;
  const ms = trialEndsAt.getTime() - Date.now();
  if (ms <= 0) return 0;
  return Math.ceil(ms / (24 * 60 * 60 * 1000));
}
