import type { FastifyInstance } from "fastify";
import type { PlansController } from "../../controllers/plans.controller.js";
import { requirePermission } from "../../middleware/auth.js";

export async function plansRoutes(app: FastifyInstance, controller: PlansController) {
  app.get(
    "/validation-plans",
    { preHandler: requirePermission("plans:read") },
    controller.list
  );

  app.get(
    "/databases/:databaseId/validation-plan",
    { preHandler: requirePermission("plans:read") },
    controller.getByDatabase
  );

  app.put(
    "/databases/:databaseId/validation-plan",
    { preHandler: requirePermission("plans:write") },
    controller.upsert
  );

  app.delete(
    "/databases/:databaseId/validation-plan",
    { preHandler: requirePermission("plans:write") },
    controller.remove
  );
}
