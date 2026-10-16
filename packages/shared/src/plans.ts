/**
 * ═══════════════════════════════════════════════════════════════════════════
 * REVENANT PLANS — single source of truth (backend + public catalog API)
 *
 * Change pricing and limits HERE. Marketing site can mirror manually;
 * `GET /api/v1/public/catalog` reads this file via listCatalogPlans().
 * ═══════════════════════════════════════════════════════════════════════════
 */

import {
  REDIS_DEFAULT_SNAPSHOT_RETENTION_HOURS,
  REDIS_MAX_SNAPSHOT_RETENTION_HOURS,
  REDIS_MIN_SNAPSHOT_RETENTION_HOURS,
} from "./redis.js";

/** Cloud org plans stored on organizations.plan */
export type OrganizationPlan = "starter" | "pro" | "enterprise";

/** All tiers shown on marketing site (includes CLI-only Developer) */
export type CatalogPlanId = "developer" | OrganizationPlan;

export type SubscriptionStatus = "trialing" | "active" | "past_due" | "canceled";

export type PlanLimitResource =
  | "databases"
  | "schedules"
  | "teamMembers"
  | "integrations"
  | "redisResources";

// ─── Pricing (edit amounts here only) ─────────────────────────────────────

export const STARTER_TRIAL_DAYS = 30;
export const STARTER_PRICE_INR = 499;
export const PRO_PRICE_INR = 1499;

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
  /** Redis instances an org may register (0 = CLI-only plan) */
  redisResources: number | null;
  /** Restore proofs (drills) allowed per calendar month, org-wide */
  redisRestoreProofsPerMonth: number | null;
  /**
   * HARD TTL ceiling for opt-in Redis snapshot artifacts, in hours.
   * A customer may request less than this, never more. null = fair use.
   * There is deliberately no "keep forever" option at any tier.
   */
  redisSnapshotRetentionHours: number | null;
  /** Whether this plan may store RDB artifacts in Revenant-managed storage */
  redisSnapshotEnabled: boolean;
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
  redisResources: 1,
  redisRestoreProofsPerMonth: 4,
  redisSnapshotRetentionHours: 24,
  redisSnapshotEnabled: true,
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
  redisResources: 10,
  redisRestoreProofsPerMonth: 30,
  redisSnapshotRetentionHours: 168,
  redisSnapshotEnabled: true,
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
      "Run Redis restore proofs locally — no Revenant Cloud storage",
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
      // CLI-only plan: `revenant redis-prove` runs on the customer's
      // own machine at no cost, but there is no cloud control plane to store
      // artifacts in. Upgrade to keep snapshots centrally.
      redisResources: 0,
      redisRestoreProofsPerMonth: null,
      redisSnapshotRetentionHours: null,
      redisSnapshotEnabled: false,
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
      "1 Redis instance — 4 restore proofs/mo, opt-in snapshots up to 24h",
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
      "MongoDB read-only validation checks — separate from SQL and AWS restore drills",
      "10 Redis instances — 30 restore proofs/mo, opt-in snapshots up to 7 days",
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
      redisResources: null,
      redisRestoreProofsPerMonth: null,
      redisSnapshotRetentionHours: null,
      redisSnapshotEnabled: true,
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

// ─── Redis snapshot TTL policy ─────────────────────────────────────────────

/** Highest TTL this plan may be granted, in hours. null = fair use. */
export function redisSnapshotRetentionCeiling(
  plan: OrganizationPlan
): number | null {
  return getPlanDefinition(plan).limits.redisSnapshotRetentionHours;
}

/**
 * Resolve the TTL to actually store on a Redis snapshot.
 *
 * Clamps DOWN to the plan ceiling — a customer asking for 1 year on Starter
 * gets 24 hours, never more. Falls back to the shared default when nothing is
 * requested. There is intentionally no path that returns null: every stored
 * artifact has a deadline, because an unbounded snapshot in someone else's
 * bucket is an unbounded bill and an unbounded liability.
 */
export function resolveRedisSnapshotRetentionHours(
  plan: OrganizationPlan,
  requested: number | null | undefined
): number {
  const fallback = REDIS_DEFAULT_SNAPSHOT_RETENTION_HOURS;
  const ceiling = redisSnapshotRetentionCeiling(plan);

  const wanted =
    typeof requested === "number" && Number.isFinite(requested)
      ? Math.max(REDIS_MIN_SNAPSHOT_RETENTION_HOURS, Math.floor(requested))
      : fallback;

  if (ceiling == null) {
    return Math.min(wanted, REDIS_MAX_SNAPSHOT_RETENTION_HOURS);
  }
  return Math.min(wanted, ceiling, REDIS_MAX_SNAPSHOT_RETENTION_HOURS);
}

/** Restore proofs remaining this calendar month. null = unlimited. */
export function redisRestoreProofsRemaining(
  plan: OrganizationPlan,
  used: number
): number | null {
  const limit = getPlanDefinition(plan).limits.redisRestoreProofsPerMonth;
  if (limit == null) return null;
  return Math.max(0, limit - used);
}
