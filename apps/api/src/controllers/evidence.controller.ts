import type { FastifyReply, FastifyRequest } from "fastify";
import { evidenceIdParamSchema } from "../validations/evidence.schema.js";
import { paginationQuerySchema } from "../validations/pagination.schema.js";
import type { EvidenceService } from "../services/evidence.service.js";
import { sendHandlerError } from "../lib/http.js";

export function createEvidenceHandlers(evidenceService: EvidenceService) {
  return {
    list: async (request: FastifyRequest, reply: FastifyReply) => {
      const query = paginationQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply
          .status(400)
          .send({ error: "Invalid pagination", code: "VALIDATION_ERROR" });
      }

      try {
        return await evidenceService.list(
          request.user.organizationId,
          query.data
        );
      } catch (err) {
        return sendHandlerError(err, request, reply, "Failed to list evidence");
      }
    },

    download: async (request: FastifyRequest, reply: FastifyReply) => {
      const params = evidenceIdParamSchema.safeParse(request.params);
      if (!params.success) {
        return reply
          .status(400)
          .send({ error: "Invalid evidence id", code: "VALIDATION_ERROR" });
      }

      try {
        const { body, artifact } = await evidenceService.getDownload(
          request.user.organizationId,
          params.data.id
        );
        return reply
          .header("Content-Type", "application/json")
          .header(
            "Content-Disposition",
            `attachment; filename="evidence-${artifact.jobId}.json"`
          )
          .send(body);
      } catch (err) {
        return sendHandlerError(err, request, reply, "Failed to download evidence");
      }
    },
  };
}

export type EvidenceHandlers = ReturnType<typeof createEvidenceHandlers>;
