import { eq } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { fundingPayments } from "../db/schema.js";
import type { Env } from "../config/env.js";
import { createAppError } from "../lib/errors.js";
import { resolveEmailBrand } from "../lib/email-layout.js";
import {
  fundingReceivedHtml,
  fundingThankYouHtml,
} from "../lib/notification-templates.js";
import {
  isTransactionalMailConfigured,
  sendTransactionalMail,
} from "../lib/transactional-mail.js";
import {
  createRazorpayClient,
  formatRazorpayError,
  isRazorpayConfigured,
  razorpayHttpStatus,
  verifyRazorpayPaymentSignature,
} from "../lib/razorpay.js";
import type {
  FundingCreateOrderInput,
  FundingVerifyPaymentInput,
} from "../validations/funding.schema.js";

const NOTIFY_DEFAULT = "bpawan277@gmail.com";

function notifyEmail(env: Env): string {
  return env.CONTACT_NOTIFY_EMAIL ?? NOTIFY_DEFAULT;
}

export function createFundingService(db: Database, env: Env) {
  const razorpayReady = isRazorpayConfigured(env.RAZORPAY_KEY_ID, env.RAZORPAY_KEY_SECRET);

  async function assertRazorpayReady() {
    if (!razorpayReady || !env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) {
      throw createAppError(
        503,
        "Online payments are not configured on this server",
        "BILLING_UNAVAILABLE"
      );
    }
    return createRazorpayClient(env.RAZORPAY_KEY_ID, env.RAZORPAY_KEY_SECRET);
  }

  return {
    isRazorpayReady(): boolean {
      return razorpayReady;
    },

    async createOrder(input: FundingCreateOrderInput) {
      const client = await assertRazorpayReady();
      const amountPaise = input.amountInr * 100;
      const receipt = `fund_${Date.now()}`;

      let order;
      try {
        order = await client.orders.create({
          amount: amountPaise,
          currency: "INR",
          receipt,
          notes: {
            purpose: "funding",
            name: input.name.slice(0, 100),
            email: input.email.toLowerCase(),
          },
        });
      } catch (err) {
        throw createAppError(
          razorpayHttpStatus(err),
          formatRazorpayError(err),
          razorpayHttpStatus(err) === 401 ? "RAZORPAY_AUTH_FAILED" : "RAZORPAY_ORDER_FAILED"
        );
      }

      try {
        await db.insert(fundingPayments).values({
          razorpayOrderId: order.id,
          amountPaise,
          currency: order.currency ?? "INR",
          status: "created",
          name: input.name.trim(),
          email: input.email.toLowerCase(),
          note: input.note?.trim() || null,
        });
      } catch (err) {
        const code =
          err && typeof err === "object" && "code" in err
            ? String((err as { code?: string }).code)
            : "";
        if (code === "42P01") {
          throw createAppError(
            503,
            "Funding tables missing. From revenant-cloud run: npm run db:migrate",
            "MIGRATION_REQUIRED"
          );
        }
        throw err;
      }

      return {
        orderId: order.id,
        amount: Number(order.amount),
        currency: order.currency ?? "INR",
        keyId: env.RAZORPAY_KEY_ID!,
        description: `Support Revenant — ₹${input.amountInr.toLocaleString("en-IN")}`,
        amountInr: input.amountInr,
      };
    },

    async verifyPayment(input: FundingVerifyPaymentInput) {
      if (!razorpayReady || !env.RAZORPAY_KEY_SECRET) {
        throw createAppError(503, "Online payments are not configured", "BILLING_UNAVAILABLE");
      }

      const valid = verifyRazorpayPaymentSignature({
        orderId: input.razorpay_order_id,
        paymentId: input.razorpay_payment_id,
        signature: input.razorpay_signature,
        keySecret: env.RAZORPAY_KEY_SECRET,
      });

      if (!valid) {
        throw createAppError(400, "Payment signature verification failed", "INVALID_SIGNATURE");
      }

      const [row] = await db
        .select()
        .from(fundingPayments)
        .where(eq(fundingPayments.razorpayOrderId, input.razorpay_order_id))
        .limit(1);

      if (!row) {
        throw createAppError(404, "Funding order not found", "ORDER_NOT_FOUND");
      }

      if (row.status === "paid") {
        return {
          ok: true,
          amountInr: Math.round(row.amountPaise / 100),
          email: row.email,
        };
      }

      const now = new Date();
      await db
        .update(fundingPayments)
        .set({
          status: "paid",
          razorpayPaymentId: input.razorpay_payment_id,
          paidAt: now,
        })
        .where(eq(fundingPayments.id, row.id));

      const amountInr = Math.round(row.amountPaise / 100);
      const brand = resolveEmailBrand(env);

      if (isTransactionalMailConfigured(env)) {
        const adminTo = notifyEmail(env);
        await Promise.all([
          sendTransactionalMail(env, {
            to: row.email,
            subject: `Thank you for supporting Revenant — ₹${amountInr}`,
            text: `Hi ${row.name},\n\nThank you for your ₹${amountInr} contribution to Revenant. It helps us ship better disaster-recovery tooling.\n\n— The Revenant team`,
            html: fundingThankYouHtml({ brand, name: row.name, amountInr }),
          }),
          sendTransactionalMail(env, {
            to: adminTo,
            replyTo: row.email,
            subject: `[Revenant] Funding received — ₹${amountInr} from ${row.name}`,
            text: `Funding payment received\n\nName: ${row.name}\nEmail: ${row.email}\nAmount: ₹${amountInr}\nPayment ID: ${input.razorpay_payment_id}\n${row.note ? `Note: ${row.note}` : ""}`,
            html: fundingReceivedHtml({
              brand,
              name: row.name,
              email: row.email,
              amountInr,
              note: row.note,
              paymentId: input.razorpay_payment_id,
            }),
          }),
        ]);
      } else if (env.NODE_ENV === "development") {
        console.log(
          `[dev] Funding ₹${amountInr} from ${row.email} (payment ${input.razorpay_payment_id})`
        );
      }

      return { ok: true, amountInr, email: row.email };
    },
  };
}

export type FundingService = ReturnType<typeof createFundingService>;
