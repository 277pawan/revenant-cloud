import type { FastifyInstance } from "fastify";
import type { RunnersHandlers } from "../../controllers/runners.controller.js";
import { requirePermission } from "../../middleware/auth.js";

export async function runnersRoutes(
  app: FastifyInstance,
  handlers: RunnersHandlers
) {
  app.get(
    "/runners",
    { preHandler: requirePermission("team:manage") },
    handlers.list
  );

  app.post(
    "/runners",
    { preHandler: requirePermission("team:manage") },
    handlers.create
  );

  app.delete(
    "/runners/:id",
    { preHandler: requirePermission("team:manage") },
    handlers.revoke
  );
}
