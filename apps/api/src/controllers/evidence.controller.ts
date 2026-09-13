import type { FastifyReply, FastifyRequest } from "fastify";
import { evidenceIdParamSchema } from "../validations/evidence.schema.js";
import { listSearchQuerySchema } from "../validations/pagination.schema.js";
import type { EvidenceService } from "../services/evidence.service.js";
import { sendHandlerError } from "../lib/http.js";

export function createEvidenceHandlers(evidenceService: EvidenceService) {
  return {
    list: async (request: FastifyRequest, reply: FastifyReply) => {
      const query = listSearchQuerySchema.safeParse(request.query);
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

    downloadPdf: async (request: FastifyRequest, reply: FastifyReply) => {
      const params = evidenceIdParamSchema.safeParse(request.params);
      if (!params.success) {
        return reply
          .status(400)
          .send({ error: "Invalid evidence id", code: "VALIDATION_ERROR" });
      }

      try {
        const { pdf, artifact } = await evidenceService.getPdf(
          request.user.organizationId,
          params.data.id
        );
        return reply
          .header("Content-Type", "application/pdf")
          .header(
            "Content-Disposition",
            `attachment; filename="revenant-evidence-${artifact.jobId}.pdf"`
          )
          .send(pdf);
      } catch (err) {
        return sendHandlerError(err, request, reply, "Failed to download PDF");
      }
    },
  };
}

export type EvidenceHandlers = ReturnType<typeof createEvidenceHandlers>;
