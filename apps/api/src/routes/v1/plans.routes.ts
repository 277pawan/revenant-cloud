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

  app.get(
    "/validation-plans/templates",
    { preHandler: requirePermission("plans:read") },
    handlers.listTemplates
  );

  app.get(
    "/validation-plans/templates/:templateId",
    { preHandler: requirePermission("plans:read") },
    handlers.getTemplate
  );

  app.get(
    "/validation-plans/composer",
    { preHandler: requirePermission("plans:read") },
    handlers.composerStatus
  );

  app.post(
    "/validation-plans/compose",
    { preHandler: requirePermission("plans:write") },
    handlers.generateYaml
  );
}
