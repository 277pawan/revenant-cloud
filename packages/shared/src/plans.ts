/**
 * ═══════════════════════════════════════════════════════════════════════════
 * REVENANT PLANS — single source of truth (backend + public catalog API)
 *
 * Change pricing and limits HERE. Marketing site can mirror manually;
 * `GET /api/v1/public/catalog` reads this file via listCatalogPlans().
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** Cloud org plans stored on organizations.plan */
export type OrganizationPlan = "starter" | "pro" | "enterprise";

/** All tiers shown on marketing site (includes CLI-only Developer) */
export type CatalogPlanId = "developer" | OrganizationPlan;

export type SubscriptionStatus = "trialing" | "active" | "past_due" | "canceled";

// ─── Pricing (edit amounts here only) ─────────────────────────────────────

export const STARTER_TRIAL_DAYS = 30;
export const STARTER_PRICE_INR = 999;
export const PRO_PRICE_INR = 4999;

export function formatPriceInr(amount: number): string {
  return `₹${amount.toLocaleString("en-IN")} / month`;
}

export const STARTER_PRICE_LABEL = formatPriceInr(STARTER_PRICE_INR);
export const PRO_PRICE_LABEL = formatPriceInr(PRO_PRICE_INR);

// ─── Limits ───────────────────────────────────────────────────────────────

export interface PlanLimits {
  cloudControlPlane: boolean;
  /** Production workflows (databases with validation plans) */
  workflows: number | null;
  schedules: number | null;
  teamMembers: number | null;
  evidenceRetentionDays: number | null;
  /** Max restore drills running at once (org-wide) */
  parallelRestoreDrills: number | null;
  awsRestoreDrills: boolean;
  /** Revenant cloud runs drills — default Starter & Pro AWS path */
  managedCloudDrills: boolean;
  /** Optional Docker/npm agent for private-network Postgres (Pro+) */
  selfHostedAgent: boolean;
  directPostgresDrills: boolean;
  integrations: boolean;
  auditLogDays: number | null;
}

export interface PlanDefinition {
  id: CatalogPlanId;
  name: string;
  priceInr: number | null;
  priceLabel: string;
  tagline: string;
  highlights: string[];
  audience: "cli" | "cloud";
  /** Free trial days on cloud signup (Starter only) */
  trialDays: number | null;
  limits: PlanLimits;
}

const STARTER_LIMITS: PlanLimits = {
  cloudControlPlane: true,
  workflows: 1,
  schedules: 1,
  teamMembers: 3,
  evidenceRetentionDays: 30,
  parallelRestoreDrills: 1,
  awsRestoreDrills: true,
  managedCloudDrills: true,
  selfHostedAgent: false,
  directPostgresDrills: false,
  integrations: true,
  auditLogDays: 30,
};

const PRO_LIMITS: PlanLimits = {
  cloudControlPlane: true,
  workflows: 10,
  schedules: 10,
  teamMembers: 15,
  evidenceRetentionDays: 365,
  parallelRestoreDrills: 3,
  awsRestoreDrills: true,
  managedCloudDrills: true,
  selfHostedAgent: true,
  directPostgresDrills: true,
  integrations: true,
  auditLogDays: 365,
};

export const PLAN_DEFINITIONS: Record<CatalogPlanId, PlanDefinition> = {
  developer: {
    id: "developer",
    name: "Developer",
    priceInr: 0,
    priceLabel: "Free forever",
    tagline: "CLI + GitHub Action — your pipeline, your AWS sandbox.",
    audience: "cli",
    trialDays: null,
    highlights: [
      "revenant CLI + GitHub Action (no cloud account)",
      "AWS snapshot restore in your own AWS account",
      "YAML in git — no dashboard or evidence vault",
    ],
    limits: {
      cloudControlPlane: false,
      workflows: null,
      schedules: null,
      teamMembers: null,
      evidenceRetentionDays: null,
      parallelRestoreDrills: null,
      awsRestoreDrills: true,
      managedCloudDrills: false,
      selfHostedAgent: false,
      directPostgresDrills: true,
      integrations: false,
      auditLogDays: null,
    },
  },
  starter: {
    id: "starter",
    name: "Starter",
    priceInr: STARTER_PRICE_INR,
    priceLabel: STARTER_PRICE_LABEL,
    tagline: "One production workflow — Revenant runs restore drills for you.",
    audience: "cloud",
    trialDays: STARTER_TRIAL_DAYS,
    highlights: [
      `${STARTER_TRIAL_DAYS}-day free trial, then ${STARTER_PRICE_LABEL}`,
      "1 production RDS workflow — managed AWS restore drill",
      "No Docker — Revenant cloud executes drills",
      "Evidence (30 days), schedules, Proof Composer, email",
    ],
    limits: STARTER_LIMITS,
  },
  pro: {
    id: "pro",
    name: "Pro",
    priceInr: PRO_PRICE_INR,
    priceLabel: PRO_PRICE_LABEL,
    tagline: "Fleet DR proof — Revenant still runs AWS drills automatically.",
    audience: "cloud",
    trialDays: null,
    highlights: [
      "Up to 10 production workflows",
      "Revenant-managed AWS drills (no Docker by default)",
      "3 parallel restore drills",
      "Optional agent for private-network Postgres only",
      "Slack, email, HTTP · 1-year evidence + audit",
    ],
    limits: PRO_LIMITS,
  },
  enterprise: {
    id: "enterprise",
    name: "Enterprise",
    priceInr: null,
    priceLabel: "Contact us",
    tagline: "SSO, custom SLAs, and compliance packaging.",
    audience: "cloud",
    trialDays: null,
    highlights: [
      "Unlimited production workflows (fair use)",
      "Managed drills + optional private-network agents",
      "SSO, dedicated support, custom retention",
    ],
    limits: {
      cloudControlPlane: true,
      workflows: null,
      schedules: null,
      teamMembers: null,
      evidenceRetentionDays: null,
      parallelRestoreDrills: null,
      awsRestoreDrills: true,
      managedCloudDrills: true,
      selfHostedAgent: true,
      directPostgresDrills: true,
      integrations: true,
      auditLogDays: null,
    },
  },
};

export const CLOUD_PLAN_IDS: OrganizationPlan[] = ["starter", "pro", "enterprise"];

export const CATALOG_PLAN_ORDER: CatalogPlanId[] = [
  "developer",
  "starter",
  "pro",
  "enterprise",
];

export function getPlanDefinition(plan: OrganizationPlan): PlanDefinition {
  return PLAN_DEFINITIONS[plan] ?? PLAN_DEFINITIONS.starter;
}

export function getCatalogPlan(id: CatalogPlanId): PlanDefinition {
  return PLAN_DEFINITIONS[id];
}

export function listCatalogPlans(): PlanDefinition[] {
  return CATALOG_PLAN_ORDER.map((id) => PLAN_DEFINITIONS[id]);
}

export function isCloudPlan(plan: CatalogPlanId): boolean {
  return plan !== "developer";
}

export function parallelRestoreDrillLimit(plan: OrganizationPlan): number | null {
  return getPlanDefinition(plan).limits.parallelRestoreDrills;
}

/** Next paid tier for upgrade hints */
export function upgradePlanTarget(current: OrganizationPlan): OrganizationPlan | null {
  if (current === "starter") return "pro";
  if (current === "pro") return "enterprise";
  return null;
}
