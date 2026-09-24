import type { FastifyReply, FastifyRequest } from "fastify";
import type { FundingService } from "../services/funding.service.js";
import {
  fundingCreateOrderSchema,
  fundingVerifyPaymentSchema,
} from "../validations/funding.schema.js";
import { sendHandlerError } from "../lib/http.js";

export function createFundingHandlers(fundingService: FundingService) {
  return {
    createOrder: async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = fundingCreateOrderSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: parsed.error.issues[0]?.message ?? "Invalid funding request",
          code: "VALIDATION_ERROR",
        });
      }

      try {
        const order = await fundingService.createOrder(parsed.data);
        return reply.status(201).send({ order });
      } catch (err) {
        return sendHandlerError(err, request, reply, "Could not start payment");
      }
    },

    verifyPayment: async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = fundingVerifyPaymentSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: parsed.error.issues[0]?.message ?? "Invalid payment verification",
          code: "VALIDATION_ERROR",
        });
      }

      try {
        const result = await fundingService.verifyPayment(parsed.data);
        return result;
      } catch (err) {
        return sendHandlerError(err, request, reply, "Payment verification failed");
      }
    },
  };
}

export type FundingHandlers = ReturnType<typeof createFundingHandlers>;
