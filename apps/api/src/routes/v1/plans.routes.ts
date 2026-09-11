import type { FastifyInstance } from "fastify";
import type { PlansHandlers } from "../../controllers/plans.controller.js";
import { requirePermission } from "../../middleware/auth.js";

export async function plansRoutes(app: FastifyInstance, handlers: PlansHandlers) {
  app.get(
    "/validation-plans",
    { preHandler: requirePermission("plans:read") },
    handlers.list
  );

  app.get(
    "/databases/:databaseId/validation-plan",
    { preHandler: requirePermission("plans:read") },
    handlers.getByDatabase
  );

  app.put(
    "/databases/:databaseId/validation-plan",
    { preHandler: requirePermission("plans:write") },
    handlers.upsert
  );

  app.delete(
    "/databases/:databaseId/validation-plan",
    { preHandler: requirePermission("plans:write") },
    handlers.remove
  );
}
