import crypto from "node:crypto";
import Razorpay from "razorpay";
import {
  PRO_PRICE_INR,
  STARTER_PRICE_INR,
  type OrganizationPlan,
} from "@revenant/shared";

export function createRazorpayClient(
  keyId: string,
  keySecret: string,
): Razorpay {
  return new Razorpay({ key_id: keyId, key_secret: keySecret });
}

export function isRazorpayConfigured(
  keyId?: string,
  keySecret?: string,
): boolean {
  return Boolean(keyId?.trim() && keySecret?.trim());
}

/** Razorpay SDK rejects with `{ statusCode, error: { description } }`, not `Error`. */
export function formatRazorpayError(err: unknown): string {
  if (err && typeof err === "object") {
    const payload = err as {
      error?: { description?: string; reason?: string };
      message?: string;
    };
    const fromApi = payload.error?.description ?? payload.error?.reason;
    if (fromApi) return fromApi;
    if (typeof payload.message === "string" && payload.message)
      return payload.message;
  }
  if (err instanceof Error && err.message) return err.message;
  return "Razorpay request failed";
}

export function razorpayHttpStatus(err: unknown): number {
  if (err && typeof err === "object" && "statusCode" in err) {
    const code = Number((err as { statusCode?: number }).statusCode);
    if (code === 401) return 401;
    if (code === 400) return 400;
    if (code >= 400 && code < 500) return 400;
    if (code >= 500) return 502;
  }
  if (/auth/i.test(formatRazorpayError(err))) return 401;
  return 502;
}

/** Standard Checkout signature: HMAC-SHA256(order_id|payment_id, secret). */
export function verifyRazorpayPaymentSignature(input: {
  orderId: string;
  paymentId: string;
  signature: string;
  keySecret: string;
}): boolean {
  const body = `${input.orderId}|${input.paymentId}`;
  const expected = crypto
    .createHmac("sha256", input.keySecret)
    .update(body)
    .digest("hex");
  return safeCompare(expected, input.signature);
}

/** Subscription auth payment: payment_id|subscription_id */
export function verifyRazorpaySubscriptionPaymentSignature(input: {
  subscriptionId: string;
  paymentId: string;
  signature: string;
  keySecret: string;
}): boolean {
  const body = `${input.paymentId}|${input.subscriptionId}`;
  const expected = crypto
    .createHmac("sha256", input.keySecret)
    .update(body)
    .digest("hex");
  return safeCompare(expected, input.signature);
}

export function verifyRazorpayWebhookSignature(input: {
  rawBody: string | Buffer;
  signature: string;
  webhookSecret: string;
}): boolean {
  const expected = crypto
    .createHmac("sha256", input.webhookSecret)
    .update(input.rawBody)
    .digest("hex");
  return safeCompare(expected, input.signature);
}

function safeCompare(expected: string, actual: string): boolean {
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, "utf8"),
      Buffer.from(actual, "utf8"),
    );
  } catch {
    return false;
  }
}

export type RazorpaySubscriptionStatus =
  | "created"
  | "authenticated"
  | "active"
  | "pending"
  | "halted"
  | "cancelled"
  | "completed"
  | "expired";

export function mapRazorpaySubscriptionToOrgStatus(rzStatus: string): {
  razorpayStatus: RazorpaySubscriptionStatus;
  subscriptionStatus?: "trialing" | "active" | "past_due" | "canceled";
} {
  switch (rzStatus) {
    case "authenticated":
      return {
        razorpayStatus: "authenticated",
        subscriptionStatus: "trialing",
      };
    case "active":
      return { razorpayStatus: "active", subscriptionStatus: "active" };
    case "pending":
      return { razorpayStatus: "pending", subscriptionStatus: "past_due" };
    case "halted":
      return { razorpayStatus: "halted", subscriptionStatus: "past_due" };
    case "cancelled":
    case "completed":
    case "expired":
      return {
        razorpayStatus: rzStatus as RazorpaySubscriptionStatus,
        subscriptionStatus: "canceled",
      };
    default:
      return { razorpayStatus: "created" };
  }
}

type RazorpayCustomerRecord = { id: string; email?: string | null };

/**
 * Create a Razorpay customer, or reuse one that already exists for this merchant.
 * Local and production share one merchant account, so an email created on localhost
 * is already on Razorpay when production tries to create it.
 *
 * The Customers API only honors `fail_existing` as the string `"0"`. Numeric `0` is
 * treated as omitted (default is fail), which returns "Customer already exists".
 */
export async function ensureRazorpayCustomer(
  client: Razorpay,
  input: { name: string; email: string; notes?: Record<string, string> },
): Promise<string> {
  try {
    const customer = (await client.customers.create({
      name: input.name,
      email: input.email,
      notes: input.notes,
      fail_existing: "0" as unknown as 0,
    })) as { id: string };
    if (!customer.id) {
      throw new Error("Razorpay did not return a customer id");
    }
    return customer.id;
  } catch (err) {
    if (!/already exists/i.test(formatRazorpayError(err))) throw err;
    const existingId = await findRazorpayCustomerIdByEmail(client, input.email);
    if (!existingId) throw err;
    return existingId;
  }
}

async function findRazorpayCustomerIdByEmail(
  client: Razorpay,
  email: string,
): Promise<string | null> {
  const target = email.trim().toLowerCase();
  const pageSize = 100;
  for (let skip = 0; skip < 1000; skip += pageSize) {
    const page = (await client.customers.all({ count: pageSize, skip })) as {
      items?: RazorpayCustomerRecord[];
    };
    const items = page.items ?? [];
    const match = items.find(
      (item) => (item.email ?? "").trim().toLowerCase() === target,
    );
    if (match?.id) return match.id;
    if (items.length < pageSize) break;
  }
  return null;
}

/** Resolve plan id — auto-create in dev if missing (dev convenience). */
export async function resolveRazorpayPlanId(
  client: Razorpay,
  plan: OrganizationPlan,
  configuredPlanId?: string,
  allowAutoCreate = false,
): Promise<string> {
  const trimmed = configuredPlanId?.trim();
  if (trimmed) return trimmed;

  if (!allowAutoCreate) {
    const envKey =
      plan === "pro" ? "RAZORPAY_PRO_PLAN_ID" : "RAZORPAY_STARTER_PLAN_ID";
    const amount = plan === "pro" ? PRO_PRICE_INR : STARTER_PRICE_INR;
    throw new Error(
      `${envKey} is not set. Create a ₹${amount}/month plan in Razorpay Dashboard → Subscriptions → Plans.`,
    );
  }

  const amountInr = plan === "pro" ? PRO_PRICE_INR : STARTER_PRICE_INR;
  const created = await client.plans.create({
    period: "monthly",
    interval: 1,
    item: {
      name: plan === "pro" ? "Revenant Pro" : "Revenant Starter",
      amount: amountInr * 100,
      currency: "INR",
      description:
        plan === "pro"
          ? "Pro cloud — fleet DR proof"
          : "Starter cloud — managed AWS restore drills",
    },
  });
  return created.id;
}
