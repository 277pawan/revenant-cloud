import type { FastifyInstance } from "fastify";
import type { BillingHandlers } from "../../controllers/billing.controller.js";
import { requireAuth } from "../../middleware/auth.js";

export async function billingRoutes(
  app: FastifyInstance,
  handlers: BillingHandlers
) {
  app.get(
    "/billing/subscription",
    { preHandler: requireAuth },
    handlers.subscription
  );
}
