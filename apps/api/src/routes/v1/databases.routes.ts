import type { FastifyInstance } from "fastify";
import type { DatabasesHandlers } from "../../controllers/databases.controller.js";
import { requirePermission } from "../../middleware/auth.js";

/**
 * databases:read  → admin | executor | viewer
 * databases:write → admin only
 * credentials:write checked via databases:write for create/update with password
 */
export async function databasesRoutes(
  app: FastifyInstance,
  handlers: DatabasesHandlers
) {
  app.get(
    "/databases",
    { preHandler: requirePermission("databases:read") },
    handlers.list
  );

  app.get(
    "/databases/:id",
    { preHandler: requirePermission("databases:read") },
    handlers.get
  );

  app.post(
    "/databases",
    { preHandler: requirePermission("databases:write") },
    handlers.create
  );

  app.patch(
    "/databases/:id",
    { preHandler: requirePermission("databases:write") },
    handlers.update
  );

  app.delete(
    "/databases/:id",
    { preHandler: requirePermission("databases:write") },
    handlers.remove
  );
}
