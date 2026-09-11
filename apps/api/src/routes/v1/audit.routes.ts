import type { FastifyInstance } from "fastify";
import type { AuditHandlers } from "../../controllers/audit.controller.js";
import { requirePermission } from "../../middleware/auth.js";

export async function auditRoutes(
  app: FastifyInstance,
  handlers: AuditHandlers
) {
  app.get(
    "/audit",
    { preHandler: requirePermission("audit:read") },
    handlers.list
  );
}
