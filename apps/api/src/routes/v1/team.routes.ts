import type { FastifyInstance } from "fastify";
import type { TeamController } from "../../controllers/team.controller.js";
import { requirePermission } from "../../middleware/auth.js";

export async function teamRoutes(app: FastifyInstance, controller: TeamController) {
  app.get(
    "/team/members",
    { preHandler: requirePermission("team:read") },
    controller.list
  );

  app.post(
    "/team/members",
    { preHandler: requirePermission("team:manage") },
    controller.invite
  );

  app.patch(
    "/team/members/:id",
    { preHandler: requirePermission("team:manage") },
    controller.update
  );

  app.delete(
    "/team/members/:id",
    { preHandler: requirePermission("team:manage") },
    controller.remove
  );
}
