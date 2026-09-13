import type { FastifyReply, FastifyRequest } from "fastify";
import { listSearchQuerySchema } from "../validations/pagination.schema.js";
import type { AuditService } from "../services/audit.service.js";
import { sendHandlerError } from "../lib/http.js";

export function createAuditHandlers(auditService: AuditService) {
  return {
    list: async (request: FastifyRequest, reply: FastifyReply) => {
      const query = listSearchQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply
          .status(400)
          .send({ error: "Invalid pagination", code: "VALIDATION_ERROR" });
      }

      try {
        return await auditService.list(
          request.user.organizationId,
          query.data
        );
      } catch (err) {
        return sendHandlerError(err, request, reply, "Failed to list audit events");
      }
    },
  };
}

export type AuditHandlers = ReturnType<typeof createAuditHandlers>;
