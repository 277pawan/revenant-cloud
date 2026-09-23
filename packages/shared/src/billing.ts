import type { OrganizationPlan, SubscriptionStatus } from "./plans.js";
import type { PlanLimits } from "./plans.js";

/** ₹1 token charge to save card / autopay mandate for Starter (100 paise). */
export const STARTER_AUTOPAY_SETUP_PAISE = 100;

export const STARTER_AUTOPAY_SETUP_LABEL = "₹1 autopay setup";

export interface OrgSubscriptionSummary {
  plan: OrganizationPlan;
  planName: string;
  priceInr: number | null;
  priceLabel: string;
  subscriptionStatus: SubscriptionStatus;
  subscriptionActive: boolean;
  trialEndsAt: string | null;
  trialDaysRemaining: number | null;
  autopaySetup: boolean;
  razorpayConfigured: boolean;
  razorpaySubscriptionId?: string | null;
  razorpaySubscriptionStatus?: string | null;
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

export type BillingCheckoutMode = "subscription" | "order";

export interface BillingCreateOrderResponse {
  checkoutMode: BillingCheckoutMode;
  /** Razorpay subscription checkout (preferred) */
  subscriptionId?: string;
  /** Legacy one-time order */
  orderId?: string;
  amount: number;
  currency: string;
  keyId: string;
  description: string;
  plan: OrganizationPlan;
  purpose: "autopay_setup";
  trialEndsAt?: string | null;
  recurringAmountInr?: number;
}

export interface BillingVerifyPaymentRequest {
  razorpay_payment_id: string;
  razorpay_signature: string;
  razorpay_order_id?: string;
  razorpay_subscription_id?: string;
}

export interface BillingVerifyPaymentResponse {
  ok: true;
  autopaySetup: boolean;
}

/** Cloud dashboard requires ₹1 autopay setup on the marketing site first. */
export function canAccessCloudDashboard(
  user: { autopaySetup?: boolean } | null | undefined
): boolean {
  return user?.autopaySetup === true;
}
