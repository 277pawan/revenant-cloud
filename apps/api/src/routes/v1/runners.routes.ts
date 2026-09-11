import type { FastifyInstance } from "fastify";
import type { RunnersHandlers } from "../../controllers/runners.controller.js";
import { requirePermission } from "../../middleware/auth.js";

export async function runnersRoutes(
  app: FastifyInstance,
  handlers: RunnersHandlers
) {
  app.get(
    "/runners/services",
    { preHandler: requirePermission("plans:read") },
    handlers.listServices
  );

  app.post(
    "/runners/databases/:id/issue-token",
    { preHandler: requirePermission("plans:write") },
    handlers.issueToken
  );
}
