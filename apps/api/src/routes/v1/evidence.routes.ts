import type { FastifyInstance } from "fastify";
import type { EvidenceHandlers } from "../../controllers/evidence.controller.js";
import { requirePermission } from "../../middleware/auth.js";

export async function evidenceRoutes(
  app: FastifyInstance,
  handlers: EvidenceHandlers
) {
  app.get(
    "/evidence",
    { preHandler: requirePermission("evidence:read") },
    handlers.list
  );

  app.get(
    "/evidence/:id/download",
    { preHandler: requirePermission("evidence:read") },
    handlers.download
  );

  app.get(
    "/evidence/:id/pdf",
    { preHandler: requirePermission("evidence:read") },
    handlers.downloadPdf
  );
}
