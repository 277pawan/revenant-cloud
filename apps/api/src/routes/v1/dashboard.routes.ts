import type { FastifyInstance } from "fastify";
import type { DashboardHandlers } from "../../controllers/dashboard.controller.js";
import { requireAuth, requirePermission } from "../../middleware/auth.js";

export async function dashboardRoutes(
  app: FastifyInstance,
  handlers: DashboardHandlers
) {
  app.get(
    "/dashboard/overview",
    { preHandler: [requireAuth, requirePermission("databases:read")] },
    handlers.overview
  );

  app.get(
    "/dashboard/rto-trends",
    { preHandler: [requireAuth, requirePermission("databases:read")] },
    handlers.rtoTrends
  );
}
