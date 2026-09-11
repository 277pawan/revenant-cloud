import type { FastifyReply, FastifyRequest } from "fastify";
import {
  databaseIdParamSchema,
  upsertValidationPlanSchema,
} from "../validations/plans.schema.js";
import { paginationQuerySchema } from "../validations/pagination.schema.js";
import type { PlansService } from "../services/plans.service.js";
import { sendHandlerError } from "../lib/http.js";

export function createPlansHandlers(plansService: PlansService) {
  return {
    list: async (request: FastifyRequest, reply: FastifyReply) => {
      const query = paginationQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply
          .status(400)
          .send({ error: "Invalid pagination", code: "VALIDATION_ERROR" });
      }

      try {
        return await plansService.list(request.user.organizationId, query.data);
      } catch (err) {
        return sendHandlerError(
          err,
          request,
          reply,
          "Failed to list validation plans"
        );
      }
    },

    getByDatabase: async (request: FastifyRequest, reply: FastifyReply) => {
      const params = databaseIdParamSchema.safeParse(request.params);
      if (!params.success) {
        return reply
          .status(400)
          .send({ error: "Invalid database id", code: "VALIDATION_ERROR" });
      }

      try {
        const plan = await plansService.getByDatabaseId(
          request.user.organizationId,
          params.data.databaseId
        );
        return { plan };
      } catch (err) {
        return sendHandlerError(
          err,
          request,
          reply,
          "Failed to get validation plan"
        );
      }
    },

    upsert: async (request: FastifyRequest, reply: FastifyReply) => {
      const params = databaseIdParamSchema.safeParse(request.params);
      if (!params.success) {
        return reply
          .status(400)
          .send({ error: "Invalid database id", code: "VALIDATION_ERROR" });
      }

      const body = upsertValidationPlanSchema.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({
          error: "Invalid request",
          code: "VALIDATION_ERROR",
          details: body.error.flatten().fieldErrors,
        });
      }

      try {
        const plan = await plansService.upsert(
          request.user.organizationId,
          params.data.databaseId,
          body.data
        );
        return { plan };
      } catch (err) {
        return sendHandlerError(
          err,
          request,
          reply,
          "Failed to save validation plan"
        );
      }
    },

    remove: async (request: FastifyRequest, reply: FastifyReply) => {
      const params = databaseIdParamSchema.safeParse(request.params);
      if (!params.success) {
        return reply
          .status(400)
          .send({ error: "Invalid database id", code: "VALIDATION_ERROR" });
      }

      try {
        await plansService.delete(
          request.user.organizationId,
          params.data.databaseId
        );
        return reply.status(204).send();
      } catch (err) {
        return sendHandlerError(
          err,
          request,
          reply,
          "Failed to delete validation plan"
        );
      }
    },
  };
}

export type PlansHandlers = ReturnType<typeof createPlansHandlers>;
