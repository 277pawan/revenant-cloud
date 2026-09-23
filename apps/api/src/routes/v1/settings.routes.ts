import type { FastifyInstance } from "fastify";
import type { SettingsHandlers } from "../../controllers/settings.controller.js";
import { requirePermission, requireRoles } from "../../middleware/auth.js";

export async function settingsRoutes(app: FastifyInstance, handlers: SettingsHandlers) {
  app.get(
    "/settings/organization",
    { preHandler: requirePermission("team:read") },
    handlers.getOrganization
  );

  app.patch(
    "/settings/organization",
    { preHandler: requireRoles("admin") },
    handlers.updateOrganization
  );

}
