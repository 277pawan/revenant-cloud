import {
  PRO_PRICE_INR,
  STARTER_AUTOPAY_SETUP_PAISE,
  STARTER_PRICE_INR,
  type BillingCreateOrderResponse,
  type BillingVerifyPaymentResponse,
  type OrgSubscriptionSummary,
  type OrganizationPlan,
  getPlanDefinition,
} from "@revenant/shared";
import type { SubscriptionStatus } from "@revenant/shared";
import { and, eq } from "drizzle-orm";
import { findOrganizationByRazorpaySubscription, hasAutopaySetup } from "../lib/billing-access.js";
import type { Database } from "../db/index.js";
import { billingOrders, organizations, users } from "../db/schema.js";
import { createAppError, isAppError } from "../lib/errors.js";
import {
  countActiveRestoreDrills,
  countPlanResource,
  getOrganizationBilling,
} from "../lib/plan-limits.js";
import {
  createRazorpayClient,
  formatRazorpayError,
  isRazorpayConfigured,
  mapRazorpaySubscriptionToOrgStatus,
  razorpayHttpStatus,
  resolveRazorpayPlanId,
  verifyRazorpayPaymentSignature,
  verifyRazorpaySubscriptionPaymentSignature,
  verifyRazorpayWebhookSignature,
} from "../lib/razorpay.js";
import {
  isSubscriptionActive,
  parseOrganizationPlan,
  trialDaysRemaining,
  trialEndsAtFromNow,
} from "../lib/org-subscription.js";
import type { Env } from "../config/env.js";

type RazorpaySubscriptionEntity = {
  id: string;
  status: string;
  notes?: Record<string, string>;
  customer_id?: string;
  start_at?: number;
};

export function createBillingService(db: Database, env: Env) {
  const razorpayReady = isRazorpayConfigured(env.RAZORPAY_KEY_ID, env.RAZORPAY_KEY_SECRET);

  async function assertRazorpayReady() {
    if (!razorpayReady || !env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) {
      throw createAppError(
        503,
        "Razorpay is not configured on this server",
        "BILLING_UNAVAILABLE"
      );
    }
    return createRazorpayClient(env.RAZORPAY_KEY_ID, env.RAZORPAY_KEY_SECRET);
  }

  async function syncOrgSubscription(
    organizationId: string,
    entity: RazorpaySubscriptionEntity
  ): Promise<void> {
    const mapped = mapRazorpaySubscriptionToOrgStatus(entity.status);
    const now = new Date();
    const patch: Partial<typeof organizations.$inferInsert> = {
      razorpaySubscriptionId: entity.id,
      razorpaySubscriptionStatus: mapped.razorpayStatus,
      updatedAt: now,
    };
    if (entity.customer_id) {
      patch.razorpayCustomerId = entity.customer_id;
    }
    if (mapped.subscriptionStatus) {
      patch.subscriptionStatus = mapped.subscriptionStatus;
    }
    const planFromNotes = entity.notes?.plan;
    if (planFromNotes === "starter" || planFromNotes === "pro") {
      patch.plan = planFromNotes;
    } else if (mapped.subscriptionStatus === "active") {
      patch.plan = "starter";
    }

    await db.update(organizations).set(patch).where(eq(organizations.id, organizationId));
  }

  /** Full 30-day trial starts when autopay (₹1) completes — not at signup. */
  async function alignTrialAfterAutopaySetup(
    organizationId: string,
    razorpaySubscriptionId?: string | null
  ): Promise<void> {
    const trialEndsAt = trialEndsAtFromNow();
    await db
      .update(organizations)
      .set({
        trialEndsAt,
        subscriptionStatus: "trialing",
        updatedAt: new Date(),
      })
      .where(eq(organizations.id, organizationId));

    if (!razorpaySubscriptionId || !razorpayReady || !env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) {
      return;
    }

    try {
      const client = createRazorpayClient(env.RAZORPAY_KEY_ID, env.RAZORPAY_KEY_SECRET);
      const startAtSec = Math.max(
        Math.floor(trialEndsAt.getTime() / 1000),
        Math.floor(Date.now() / 1000) + 600
      );
      await (
        client.subscriptions.update as (
          id: string,
          body: { start_at: number }
        ) => Promise<unknown>
      )(razorpaySubscriptionId, { start_at: startAtSec });
    } catch (err) {
      console.warn(
        "[billing] Razorpay start_at sync failed (trial extended in app):",
        formatRazorpayError(err)
      );
    }
  }

  function recurringAmountInr(plan: OrganizationPlan): number {
    return plan === "pro" ? PRO_PRICE_INR : STARTER_PRICE_INR;
  }

  function subscriptionCheckoutResponse(
    subscriptionId: string,
    billingPlan: OrganizationPlan,
    planDef: ReturnType<typeof getPlanDefinition>,
    monthlyInr: number,
    trialEndsAt: Date
  ): BillingCreateOrderResponse {
    return {
      checkoutMode: "subscription",
      subscriptionId,
      amount: STARTER_AUTOPAY_SETUP_PAISE,
      currency: "INR",
      keyId: env.RAZORPAY_KEY_ID!,
      description:
        `${planDef.name} autopay — ₹1 today to verify your card. ₹${monthlyInr}/month starts after your free trial.`,
      plan: billingPlan,
      purpose: "autopay_setup",
      trialEndsAt: trialEndsAt.toISOString(),
      recurringAmountInr: monthlyInr,
    };
  }

  async function clearStaleSubscription(organizationId: string): Promise<void> {
    await db
      .update(organizations)
      .set({
        razorpaySubscriptionId: null,
        razorpaySubscriptionStatus: null,
        updatedAt: new Date(),
      })
      .where(eq(organizations.id, organizationId));
  }

  /** Resume abandoned checkout or clear dead subscriptions instead of hard 409. */
  async function resolveExistingSubscriptionCheckout(
    client: ReturnType<typeof createRazorpayClient>,
    organizationId: string,
    subscriptionId: string,
    billingPlan: OrganizationPlan,
    planDef: ReturnType<typeof getPlanDefinition>,
    monthlyInr: number,
    trialEndsAt: Date
  ): Promise<BillingCreateOrderResponse | null> {
    try {
      const existing = (await client.subscriptions.fetch(
        subscriptionId
      )) as RazorpaySubscriptionEntity;

      await syncOrgSubscription(organizationId, existing);

      if (["authenticated", "active", "pending"].includes(existing.status)) {
        throw createAppError(
          409,
          "Autopay is already set up for this organization",
          "AUTOPAY_ALREADY_ACTIVE"
        );
      }

      if (existing.status === "created") {
        return subscriptionCheckoutResponse(
          existing.id,
          billingPlan,
          planDef,
          monthlyInr,
          trialEndsAt
        );
      }

      await clearStaleSubscription(organizationId);
      return null;
    } catch (err) {
      if (isAppError(err)) throw err;
      const status = razorpayHttpStatus(err);
      if (status === 404) {
        await clearStaleSubscription(organizationId);
        return null;
      }
      throw createAppError(
        status,
        formatRazorpayError(err),
        status === 401 ? "RAZORPAY_AUTH_FAILED" : "RAZORPAY_SUBSCRIPTION_FAILED"
      );
    }
  }

  async function createLegacyOrderCheckout(
    client: ReturnType<typeof createRazorpayClient>,
    organizationId: string,
    userId: string,
    trialEndsAt: Date,
    billingPlan: OrganizationPlan
  ): Promise<BillingCreateOrderResponse> {
    const amount = STARTER_AUTOPAY_SETUP_PAISE;
    const monthlyInr = recurringAmountInr(billingPlan);
    const planDef = getPlanDefinition(billingPlan);
    const receipt = `${billingPlan}_setup_${organizationId.slice(0, 8)}_${Date.now()}`;
    const order = await client.orders.create({
      amount,
      currency: "INR",
      receipt,
      notes: {
        organizationId,
        plan: billingPlan,
        purpose: "autopay_setup",
      },
    });

    await db.insert(billingOrders).values({
      organizationId,
      razorpayOrderId: order.id,
      amountPaise: amount,
      currency: order.currency ?? "INR",
      plan: billingPlan,
      purpose: "autopay_setup",
      status: "created",
      createdByUserId: userId,
    });

    return {
      checkoutMode: "order",
      orderId: order.id,
      amount: Number(order.amount),
      currency: order.currency,
      keyId: env.RAZORPAY_KEY_ID!,
      description:
        `${planDef.name} autopay setup — ₹1 today to save your card. ₹${monthlyInr}/month after trial.`,
      plan: billingPlan,
      purpose: "autopay_setup",
      trialEndsAt: trialEndsAt.toISOString(),
      recurringAmountInr: monthlyInr,
    };
  }

  return {
    isRazorpayReady(): boolean {
      return razorpayReady;
    },

    async getSubscriptionSummary(organizationId: string): Promise<OrgSubscriptionSummary> {
      const billing = await getOrganizationBilling(db, organizationId);
      const planId = parseOrganizationPlan(billing.plan);
      const plan = getPlanDefinition(planId);
      const autopaySetup = await hasAutopaySetup(db, organizationId);

      const [orgRow] = await db
        .select({
          razorpaySubscriptionId: organizations.razorpaySubscriptionId,
          razorpaySubscriptionStatus: organizations.razorpaySubscriptionStatus,
        })
        .from(organizations)
        .where(eq(organizations.id, organizationId))
        .limit(1);

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
        autopaySetup,
        razorpayConfigured: razorpayReady,
        razorpaySubscriptionId: orgRow?.razorpaySubscriptionId ?? null,
        razorpaySubscriptionStatus: orgRow?.razorpaySubscriptionStatus ?? null,
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

    /** Subscription checkout: ₹1 addon today + monthly charge after trial (`start_at`). */
    async createStarterAutopayOrder(
      organizationId: string,
      userId: string
    ): Promise<BillingCreateOrderResponse> {
      const client = await assertRazorpayReady();

      if (await hasAutopaySetup(db, organizationId)) {
        throw createAppError(
          409,
          "Autopay is already set up for this organization",
          "AUTOPAY_ALREADY_ACTIVE"
        );
      }

      const [org] = await db
        .select({
          id: organizations.id,
          name: organizations.name,
          plan: organizations.plan,
          trialEndsAt: organizations.trialEndsAt,
          razorpayCustomerId: organizations.razorpayCustomerId,
          razorpaySubscriptionId: organizations.razorpaySubscriptionId,
        })
        .from(organizations)
        .where(eq(organizations.id, organizationId))
        .limit(1);

      if (!org) {
        throw createAppError(404, "Organization not found", "NOT_FOUND");
      }

      const [adminUser] = await db
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);

      if (!adminUser?.email) {
        throw createAppError(400, "User email required for billing", "VALIDATION_ERROR");
      }

      const billingPlan = parseOrganizationPlan(org.plan);
      if (billingPlan !== "starter" && billingPlan !== "pro") {
        throw createAppError(
          400,
          "Enterprise billing is handled manually — contact sales",
          "VALIDATION_ERROR"
        );
      }

      const planDef = getPlanDefinition(billingPlan);
      const monthlyInr = recurringAmountInr(billingPlan);
      const trialEndsAt = org.trialEndsAt ?? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

      if (org.razorpaySubscriptionId) {
        const resumed = await resolveExistingSubscriptionCheckout(
          client,
          organizationId,
          org.razorpaySubscriptionId,
          billingPlan,
          planDef,
          monthlyInr,
          trialEndsAt
        );
        if (resumed) return resumed;
      }
      const startAtSec = Math.max(
        Math.floor(trialEndsAt.getTime() / 1000),
        Math.floor(Date.now() / 1000) + 600
      );

      const configuredPlanId =
        billingPlan === "pro" ? env.RAZORPAY_PRO_PLAN_ID : env.RAZORPAY_STARTER_PLAN_ID;

      let planId: string;
      try {
        planId = await resolveRazorpayPlanId(
          client,
          billingPlan,
          configuredPlanId,
          env.RAZORPAY_AUTO_CREATE_PLAN || env.NODE_ENV !== "production"
        );
      } catch (err) {
        throw createAppError(
          503,
          err instanceof Error ? err.message : `${planDef.name} plan is not configured`,
          "BILLING_MISCONFIGURED"
        );
      }

      let customerId = org.razorpayCustomerId;
      if (!customerId) {
        try {
          const customer = (await client.customers.create({
            name: org.name,
            email: adminUser.email,
            fail_existing: 0,
            notes: { organizationId },
          })) as { id: string };
          customerId = customer.id;
          await db
            .update(organizations)
            .set({ razorpayCustomerId: customerId, updatedAt: new Date() })
            .where(eq(organizations.id, organizationId));
        } catch (err) {
          const message = formatRazorpayError(err);
          throw createAppError(razorpayHttpStatus(err), message, "RAZORPAY_CUSTOMER_FAILED");
        }
      }

      let subscription: RazorpaySubscriptionEntity;
      try {
        const subscriptionBody = {
          plan_id: planId,
          customer_id: customerId,
          total_count: 120,
          customer_notify: 1,
          start_at: startAtSec,
          addons: [
            {
              item: {
                name: "Card verification",
                amount: STARTER_AUTOPAY_SETUP_PAISE,
                currency: "INR",
              },
            },
          ],
          notes: {
            organizationId,
            plan: billingPlan,
            purpose: "autopay_setup",
          },
        };
        subscription = (await (
          client.subscriptions.create as (body: typeof subscriptionBody) => Promise<RazorpaySubscriptionEntity>
        )(subscriptionBody)) as RazorpaySubscriptionEntity;
      } catch (subErr) {
        try {
          return await createLegacyOrderCheckout(
            client,
            organizationId,
            userId,
            trialEndsAt,
            billingPlan
          );
        } catch (orderErr) {
          const message = formatRazorpayError(subErr);
          const statusCode = razorpayHttpStatus(subErr);
          const orderMessage = formatRazorpayError(orderErr);
          throw createAppError(
            statusCode,
            `${message} (subscription). Fallback order also failed: ${orderMessage}`,
            statusCode === 401 ? "RAZORPAY_AUTH_FAILED" : "RAZORPAY_SUBSCRIPTION_FAILED"
          );
        }
      }

      try {
        await db.insert(billingOrders).values({
          organizationId,
          razorpaySubscriptionId: subscription.id,
          amountPaise: STARTER_AUTOPAY_SETUP_PAISE,
          currency: "INR",
          plan: billingPlan,
          purpose: "autopay_setup",
          status: "created",
          createdByUserId: userId,
        });

        await db
          .update(organizations)
          .set({
            razorpaySubscriptionId: subscription.id,
            razorpaySubscriptionStatus: subscription.status,
            updatedAt: new Date(),
          })
          .where(eq(organizations.id, organizationId));
      } catch (err) {
        const code =
          err && typeof err === "object" && "code" in err
            ? String((err as { code?: string }).code)
            : "";
        if (code === "42P01") {
          throw createAppError(
            503,
            "Billing tables missing. From revenant-cloud run: npm run db:migrate",
            "MIGRATION_REQUIRED"
          );
        }
        throw err;
      }

      return subscriptionCheckoutResponse(
        subscription.id,
        billingPlan,
        planDef,
        monthlyInr,
        trialEndsAt
      );
    },

    async verifyStarterAutopayPayment(
      organizationId: string,
      userId: string,
      input: {
        razorpay_order_id?: string;
        razorpay_subscription_id?: string;
        razorpay_payment_id: string;
        razorpay_signature: string;
      }
    ): Promise<BillingVerifyPaymentResponse> {
      if (!razorpayReady || !env.RAZORPAY_KEY_SECRET) {
        throw createAppError(503, "Razorpay is not configured", "BILLING_UNAVAILABLE");
      }

      const { razorpay_order_id, razorpay_subscription_id, razorpay_payment_id, razorpay_signature } =
        input;

      if (!razorpay_payment_id || !razorpay_signature) {
        throw createAppError(400, "Missing payment verification fields", "VALIDATION_ERROR");
      }

      if (razorpay_subscription_id) {
        const valid = verifyRazorpaySubscriptionPaymentSignature({
          subscriptionId: razorpay_subscription_id,
          paymentId: razorpay_payment_id,
          signature: razorpay_signature,
          keySecret: env.RAZORPAY_KEY_SECRET,
        });
        if (!valid) {
          throw createAppError(400, "Payment signature verification failed", "INVALID_SIGNATURE");
        }

        const [orderRow] = await db
          .select()
          .from(billingOrders)
          .where(
            and(
              eq(billingOrders.razorpaySubscriptionId, razorpay_subscription_id),
              eq(billingOrders.organizationId, organizationId)
            )
          )
          .limit(1);

        if (!orderRow) {
          throw createAppError(404, "Subscription checkout not found", "ORDER_NOT_FOUND");
        }

        if (orderRow.status === "paid") {
          return { ok: true, autopaySetup: true };
        }

        const client = createRazorpayClient(env.RAZORPAY_KEY_ID!, env.RAZORPAY_KEY_SECRET);
        const subscription = (await client.subscriptions.fetch(
          razorpay_subscription_id
        )) as RazorpaySubscriptionEntity;

        const now = new Date();
        await db
          .update(billingOrders)
          .set({
            status: "paid",
            razorpayPaymentId: razorpay_payment_id,
            paidAt: now,
          })
          .where(eq(billingOrders.id, orderRow.id));

        await syncOrgSubscription(organizationId, subscription);
        await alignTrialAfterAutopaySetup(organizationId, razorpay_subscription_id);

        void userId;
        return { ok: true, autopaySetup: true };
      }

      if (!razorpay_order_id) {
        throw createAppError(
          400,
          "razorpay_subscription_id or razorpay_order_id is required",
          "VALIDATION_ERROR"
        );
      }

      const valid = verifyRazorpayPaymentSignature({
        orderId: razorpay_order_id,
        paymentId: razorpay_payment_id,
        signature: razorpay_signature,
        keySecret: env.RAZORPAY_KEY_SECRET,
      });

      if (!valid) {
        throw createAppError(400, "Payment signature verification failed", "INVALID_SIGNATURE");
      }

      const [orderRow] = await db
        .select()
        .from(billingOrders)
        .where(
          and(
            eq(billingOrders.razorpayOrderId, razorpay_order_id),
            eq(billingOrders.organizationId, organizationId)
          )
        )
        .limit(1);

      if (!orderRow) {
        throw createAppError(404, "Order not found for this organization", "ORDER_NOT_FOUND");
      }

      if (orderRow.status === "paid") {
        return { ok: true, autopaySetup: true };
      }

      const now = new Date();
      await db
        .update(billingOrders)
        .set({
          status: "paid",
          razorpayPaymentId: razorpay_payment_id,
          paidAt: now,
        })
        .where(eq(billingOrders.id, orderRow.id));

      await alignTrialAfterAutopaySetup(organizationId, null);

      void userId;
      return { ok: true, autopaySetup: true };
    },

    async handleRazorpayWebhook(rawBody: Buffer, signatureHeader: string | undefined) {
      if (!env.RAZORPAY_WEBHOOK_SECRET?.trim()) {
        throw createAppError(
          503,
          "RAZORPAY_WEBHOOK_SECRET is not configured",
          "BILLING_UNAVAILABLE"
        );
      }

      if (!signatureHeader) {
        throw createAppError(400, "Missing Razorpay signature", "INVALID_SIGNATURE");
      }

      const valid = verifyRazorpayWebhookSignature({
        rawBody,
        signature: signatureHeader,
        webhookSecret: env.RAZORPAY_WEBHOOK_SECRET,
      });

      if (!valid) {
        throw createAppError(400, "Invalid webhook signature", "INVALID_SIGNATURE");
      }

      const payload = JSON.parse(rawBody.toString("utf8")) as {
        event?: string;
        payload?: {
          subscription?: { entity?: RazorpaySubscriptionEntity };
          payment?: { entity?: { id?: string; subscription_id?: string } };
        };
      };

      const event = payload.event ?? "";
      const subscription = payload.payload?.subscription?.entity;

      if (subscription?.id) {
        const organizationId = await findOrganizationByRazorpaySubscription(
          db,
          subscription.id,
          subscription.notes
        );
        if (organizationId) {
          await syncOrgSubscription(organizationId, subscription);
          if (event === "subscription.authenticated") {
            await alignTrialAfterAutopaySetup(organizationId, subscription.id);
          }
        }
      }

      if (event === "subscription.charged" && subscription?.id) {
        const organizationId = await findOrganizationByRazorpaySubscription(
          db,
          subscription.id,
          subscription.notes
        );
        if (organizationId) {
          const planFromNotes = subscription.notes?.plan;
          const chargedPlan =
            planFromNotes === "pro" || planFromNotes === "starter" ? planFromNotes : "starter";
          await db
            .update(organizations)
            .set({
              subscriptionStatus: "active",
              plan: chargedPlan,
              updatedAt: new Date(),
            })
            .where(eq(organizations.id, organizationId));
        }
      }

      return { ok: true, event };
    },
  };
}

export type BillingService = ReturnType<typeof createBillingService>;
