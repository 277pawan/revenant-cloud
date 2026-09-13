/** Product limits — enforce in API later; UI uses for upsell copy today */
export interface PlanDefinition {
  id: "starter" | "pro" | "enterprise";
  name: string;
  priceInr: number | null;
  priceLabel: string;
  tagline: string;
  highlights: string[];
  limits: {
    databases: number | null;
    schedules: number | null;
    teamMembers: number | null;
    evidenceRetentionDays: number | null;
    awsRestoreDrills: boolean;
    integrations: boolean;
    auditLogDays: number | null;
  };
}

export const PLAN_DEFINITIONS: Record<
  "starter" | "pro" | "enterprise",
  PlanDefinition
> = {
  starter: {
    id: "starter",
    name: "Starter",
    priceInr: 999,
    priceLabel: "₹999 / month",
    tagline: "Prove restore works for one critical database.",
    highlights: [
      "1 database workflow",
      "Manual + scheduled drills",
      "Evidence vault (30 days)",
      "Email alerts",
    ],
    limits: {
      databases: 1,
      schedules: 1,
      teamMembers: 3,
      evidenceRetentionDays: 30,
      awsRestoreDrills: true,
      integrations: true,
      auditLogDays: 30,
    },
  },
  pro: {
    id: "pro",
    name: "Pro",
    priceInr: 4999,
    priceLabel: "₹4,999 / month",
    tagline: "Fleet-wide DR proof for growing teams.",
    highlights: [
      "Up to 10 database workflows",
      "AWS snapshot restore drills",
      "Evidence vault (1 year)",
      "Slack + email + custom HTTP",
      "Full audit log",
    ],
    limits: {
      databases: 10,
      schedules: 10,
      teamMembers: 15,
      evidenceRetentionDays: 365,
      awsRestoreDrills: true,
      integrations: true,
      auditLogDays: 365,
    },
  },
  enterprise: {
    id: "enterprise",
    name: "Enterprise",
    priceInr: null,
    priceLabel: "Contact us",
    tagline: "SSO, custom SLAs, and compliance packaging.",
    highlights: [
      "Unlimited workflows",
      "SSO (website + app)",
      "Dedicated support",
      "Custom evidence retention",
      "SOC2-ready exports",
    ],
    limits: {
      databases: null,
      schedules: null,
      teamMembers: null,
      evidenceRetentionDays: null,
      awsRestoreDrills: true,
      integrations: true,
      auditLogDays: null,
    },
  },
};

export function getPlanDefinition(
  plan: "starter" | "pro" | "enterprise"
): PlanDefinition {
  return PLAN_DEFINITIONS[plan] ?? PLAN_DEFINITIONS.starter;
}
