import { and, eq } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { billingOrders, organizations } from "../db/schema.js";

const ACTIVE_RAZORPAY_SUBSCRIPTION = ["authenticated", "active", "pending"] as const;

export async function hasAutopaySetup(db: Database, organizationId: string): Promise<boolean> {
  const [org] = await db
    .select({
      razorpaySubscriptionId: organizations.razorpaySubscriptionId,
      razorpaySubscriptionStatus: organizations.razorpaySubscriptionStatus,
    })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);

  if (
    org?.razorpaySubscriptionId &&
    org.razorpaySubscriptionStatus &&
    ACTIVE_RAZORPAY_SUBSCRIPTION.includes(
      org.razorpaySubscriptionStatus as (typeof ACTIVE_RAZORPAY_SUBSCRIPTION)[number]
    )
  ) {
    return true;
  }

  const [row] = await db
    .select({ id: billingOrders.id })
    .from(billingOrders)
    .where(
      and(
        eq(billingOrders.organizationId, organizationId),
        eq(billingOrders.purpose, "autopay_setup"),
        eq(billingOrders.status, "paid")
      )
    )
    .limit(1);
  return Boolean(row);
}

export function subscriptionIdFromWebhookEntity(entity: {
  id?: string;
  notes?: Record<string, string>;
}): string | null {
  return entity.id?.trim() || null;
}

export async function findOrganizationByRazorpaySubscription(
  db: Database,
  subscriptionId: string,
  notes?: Record<string, string>
): Promise<string | null> {
  if (notes?.organizationId) return notes.organizationId;

  const [org] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.razorpaySubscriptionId, subscriptionId))
    .limit(1);
  return org?.id ?? null;
}
