import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { BillingService } from "../services/billing.service.js";
import type { AuditService } from "../services/audit.service.js";
import { sendHandlerError } from "../lib/http.js";
import {
  createBillingOrderSchema,
  selectBillingPlanSchema,
} from "../validations/billing.schema.js";

const verifyPaymentSchema = z
  .object({
    razorpay_payment_id: z.string().min(1),
    razorpay_signature: z.string().min(1),
    razorpay_order_id: z.string().min(1).optional(),
    razorpay_subscription_id: z.string().min(1).optional(),
  })
  .refine((v) => Boolean(v.razorpay_order_id || v.razorpay_subscription_id), {
    message: "razorpay_subscription_id or razorpay_order_id is required",
  });

export function createBillingHandlers(
  billingService: BillingService,
  auditService: AuditService
) {
  return {
    subscription: async (request: FastifyRequest) => {
      const summary = await billingService.getSubscriptionSummary(
        request.user.organizationId
      );
      return { subscription: summary };
    },

    selectPlan: async (request: FastifyRequest, reply: FastifyReply) => {
      const body = selectBillingPlanSchema.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({
          error: body.error.issues[0]?.message ?? "Invalid plan",
          code: "VALIDATION_ERROR",
        });
      }

      try {
        const result = await billingService.selectBillingPlan(
          request.user.organizationId,
          body.data.plan
        );
        return result;
      } catch (err) {
        return sendHandlerError(err, request, reply, "Failed to select billing plan");
      }
    },

    upgradePro: async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const order = await billingService.createProUpgradeCheckout(
          request.user.organizationId,
          request.user.id
        );
        return reply.status(201).send({ order });
      } catch (err) {
        return sendHandlerError(err, request, reply, "Failed to start Pro upgrade checkout");
      }
    },

    createOrder: async (request: FastifyRequest, reply: FastifyReply) => {
      const body = createBillingOrderSchema.safeParse(
        request.body && typeof request.body === "object" ? request.body : {}
      );
      if (!body.success) {
        return reply.status(400).send({
          error: body.error.issues[0]?.message ?? "Invalid checkout request",
          code: "VALIDATION_ERROR",
        });
      }

      try {
        if (body.data?.plan) {
          await billingService.selectBillingPlan(request.user.organizationId, body.data.plan);
        }
        const order = await billingService.createStarterAutopayOrder(
          request.user.organizationId,
          request.user.id
        );
        return reply.status(201).send({ order });
      } catch (err) {
        return sendHandlerError(err, request, reply, "Failed to create payment checkout");
      }
    },

    verifyPayment: async (request: FastifyRequest, reply: FastifyReply) => {
      const body = verifyPaymentSchema.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({
          error: body.error.issues[0]?.message ?? "Missing or invalid payment fields",
          code: "VALIDATION_ERROR",
        });
      }

      try {
        const result = await billingService.verifyStarterAutopayPayment(
          request.user.organizationId,
          request.user.id,
          body.data
        );

        await auditService.log({
          organizationId: request.user.organizationId,
          actorUserId: request.user.id,
          action:
            result.checkoutPurpose === "pro_upgrade"
              ? "billing.upgrade_pro"
              : "billing.autopay_setup",
          resourceType: "organization",
          resourceId: request.user.organizationId,
          metadata: {
            razorpay_order_id: body.data.razorpay_order_id,
            razorpay_subscription_id: body.data.razorpay_subscription_id,
            razorpay_payment_id: body.data.razorpay_payment_id,
            amountPaise: 100,
          },
        });

        const subscription = await billingService.getSubscriptionSummary(
          request.user.organizationId
        );

        return { ...result, subscription };
      } catch (err) {
        return sendHandlerError(err, request, reply, "Payment verification failed");
      }
    },

    webhook: async (request: FastifyRequest, reply: FastifyReply) => {
      const rawBody = (request as FastifyRequest & { rawBody?: Buffer }).rawBody;
      if (!rawBody) {
        return reply.status(400).send({ error: "Invalid webhook body", code: "VALIDATION_ERROR" });
      }

      const signature =
        (request.headers["x-razorpay-signature"] as string | undefined) ??
        (request.headers["X-Razorpay-Signature"] as string | undefined);

      try {
        const result = await billingService.handleRazorpayWebhook(rawBody, signature);
        return result;
      } catch (err) {
        return sendHandlerError(err, request, reply, "Webhook processing failed");
      }
    },
  };
}

export type BillingHandlers = ReturnType<typeof createBillingHandlers>;
