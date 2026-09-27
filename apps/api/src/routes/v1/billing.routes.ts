import { Readable } from "node:stream";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { BillingHandlers } from "../../controllers/billing.controller.js";
import { requireAuth } from "../../middleware/auth.js";
import { requireRoles } from "../../middleware/auth.js";

export async function billingRoutes(
  app: FastifyInstance,
  handlers: BillingHandlers
) {
  app.get(
    "/billing/subscription",
    { preHandler: requireAuth },
    handlers.subscription
  );

  app.post(
    "/billing/select-plan",
    { preHandler: [requireAuth, requireRoles("admin")] },
    handlers.selectPlan
  );

  app.post(
    "/billing/upgrade-pro",
    { preHandler: [requireAuth, requireRoles("admin")] },
    handlers.upgradePro
  );

  app.post(
    "/billing/create-order",
    { preHandler: [requireAuth, requireRoles("admin")] },
    handlers.createOrder
  );

  app.post(
    "/billing/verify-payment",
    { preHandler: [requireAuth, requireRoles("admin")] },
    handlers.verifyPayment
  );

  app.post(
    "/billing/razorpay/webhook",
    {
      preParsing: async (request, _reply, payload) => {
        const chunks: Buffer[] = [];
        for await (const chunk of payload) {
          chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
        }
        const raw = Buffer.concat(chunks);
        (request as FastifyRequest & { rawBody?: Buffer }).rawBody = raw;
        return Readable.from([raw]);
      },
    },
    handlers.webhook
  );
}
