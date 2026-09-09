import type { FastifyInstance } from "fastify";
import type { DatabasesController } from "../../controllers/databases.controller.js";
import { requirePermission } from "../../middleware/auth.js";

/**
 * databases:read  → admin | executor | viewer
 * databases:write → admin only
 * credentials:write checked via databases:write for create/update with password
 */
export async function databasesRoutes(
  app: FastifyInstance,
  controller: DatabasesController
) {
  app.get(
    "/databases",
    { preHandler: requirePermission("databases:read") },
    controller.list
  );

  app.get(
    "/databases/:id",
    { preHandler: requirePermission("databases:read") },
    controller.get
  );

  app.post(
    "/databases",
    { preHandler: requirePermission("databases:write") },
    controller.create
  );

  app.patch(
    "/databases/:id",
    { preHandler: requirePermission("databases:write") },
    controller.update
  );

  app.delete(
    "/databases/:id",
    { preHandler: requirePermission("databases:write") },
    controller.remove
  );
}
