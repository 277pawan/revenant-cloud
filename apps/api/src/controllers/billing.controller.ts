import type { FastifyRequest } from "fastify";
import type { BillingService } from "../services/billing.service.js";

export function createBillingHandlers(billingService: BillingService) {
  return {
    subscription: async (request: FastifyRequest) => {
      const summary = await billingService.getSubscriptionSummary(
        request.user.organizationId
      );
      return { subscription: summary };
    },
  };
}

export type BillingHandlers = ReturnType<typeof createBillingHandlers>;
