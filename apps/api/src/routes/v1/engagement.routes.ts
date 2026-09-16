import type { FastifyInstance } from "fastify";
import type { EngagementHandlers } from "../../controllers/engagement.controller.js";
import { requireRoles } from "../../middleware/auth.js";

export async function engagementRoutes(
  app: FastifyInstance,
  handlers: EngagementHandlers
) {
  app.get(
    "/engagement/stats",
    { preHandler: [requireRoles("admin")] },
    handlers.stats
  );
}
