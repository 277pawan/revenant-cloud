import type { FastifyReply, FastifyRequest } from "fastify";
import {
  createRunnerSchema,
  runnerIdParamSchema,
} from "../validations/runners.schema.js";
import { paginationQuerySchema } from "../validations/pagination.schema.js";
import type { RunnersService } from "../services/runners.service.js";
import { sendHandlerError } from "../lib/http.js";

export function createRunnersHandlers(runnersService: RunnersService) {
  return {
    list: async (request: FastifyRequest, reply: FastifyReply) => {
      const query = paginationQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply
          .status(400)
          .send({ error: "Invalid pagination", code: "VALIDATION_ERROR" });
      }

      try {
        return await runnersService.list(
          request.user.organizationId,
          query.data
        );
      } catch (err) {
        return sendHandlerError(err, request, reply, "Failed to list runners");
      }
    },

    create: async (request: FastifyRequest, reply: FastifyReply) => {
      const body = createRunnerSchema.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({
          error: "Invalid request",
          code: "VALIDATION_ERROR",
          details: body.error.flatten().fieldErrors,
        });
      }

      try {
        const runner = await runnersService.create(
          request.user.organizationId,
          body.data
        );
        return reply.status(201).send({ runner });
      } catch (err) {
        return sendHandlerError(err, request, reply, "Failed to create runner");
      }
    },

    revoke: async (request: FastifyRequest, reply: FastifyReply) => {
      const params = runnerIdParamSchema.safeParse(request.params);
      if (!params.success) {
        return reply
          .status(400)
          .send({ error: "Invalid runner id", code: "VALIDATION_ERROR" });
      }

      try {
        await runnersService.revoke(
          request.user.organizationId,
          params.data.id
        );
        return reply.status(204).send();
      } catch (err) {
        return sendHandlerError(err, request, reply, "Failed to revoke runner");
      }
    },
  };
}

export type RunnersHandlers = ReturnType<typeof createRunnersHandlers>;
