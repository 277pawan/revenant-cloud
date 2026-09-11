import type { FastifyInstance } from "fastify";
import type { TeamHandlers } from "../../controllers/team.controller.js";
import { requirePermission } from "../../middleware/auth.js";

export async function teamRoutes(app: FastifyInstance, handlers: TeamHandlers) {
  app.get(
    "/team/members",
    { preHandler: requirePermission("team:read") },
    handlers.list
  );

  app.post(
    "/team/members",
    { preHandler: requirePermission("team:manage") },
    handlers.invite
  );

  app.patch(
    "/team/members/:id",
    { preHandler: requirePermission("team:manage") },
    handlers.update
  );

  app.delete(
    "/team/members/:id",
    { preHandler: requirePermission("team:manage") },
    handlers.remove
  );
}
