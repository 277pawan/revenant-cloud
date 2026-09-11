import type { FastifyReply, FastifyRequest } from "fastify";
import { databaseIdParamSchema } from "../validations/databases.schema.js";
import type { RunnersService } from "../services/runners.service.js";
import { sendHandlerError } from "../lib/http.js";

export function createRunnersHandlers(runnersService: RunnersService) {
  return {
    listServices: async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const services = await runnersService.listServices(
          request.user.organizationId
        );
        return { services };
      } catch (err) {
        return sendHandlerError(err, request, reply, "Failed to list services");
      }
    },

    issueToken: async (request: FastifyRequest, reply: FastifyReply) => {
      const params = databaseIdParamSchema.safeParse(request.params);
      if (!params.success) {
        return reply
          .status(400)
          .send({ error: "Invalid database id", code: "VALIDATION_ERROR" });
      }

      try {
        const { token, runnerId } = await runnersService.issueToken(
          request.user.organizationId,
          params.data.id
        );
        return reply.status(201).send({ token, runnerId });
      } catch (err) {
        return sendHandlerError(err, request, reply, "Failed to issue token");
      }
    },

    whoami: async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.runnerAuth) {
        return reply
          .status(401)
          .send({ error: "Unauthorized runner", code: "UNAUTHORIZED" });
      }

      if (request.runnerAuth.type === "stub") {
        return {
          identity: {
            type: "stub",
            runnerId: null,
            organizationId: null,
            databaseId: null,
            name: "stub",
            kind: "stub",
            lastSeenAt: null,
          },
        };
      }

      try {
        const identity = await runnersService.identity(
          request.runnerAuth.runnerId,
          request.runnerAuth.organizationId
        );
        return { identity };
      } catch (err) {
        return sendHandlerError(err, request, reply, "Failed to resolve runner");
      }
    },
  };
}

export type RunnersHandlers = ReturnType<typeof createRunnersHandlers>;
