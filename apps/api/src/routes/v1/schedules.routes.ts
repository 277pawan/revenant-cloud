import type { FastifyInstance } from "fastify";
import type { SchedulesHandlers } from "../../controllers/schedules.controller.js";
import { requirePermission } from "../../middleware/auth.js";

export async function schedulesRoutes(
  app: FastifyInstance,
  handlers: SchedulesHandlers
) {
  app.get(
    "/schedules",
    { preHandler: requirePermission("schedules:read") },
    handlers.list
  );

  app.post(
    "/schedules",
    { preHandler: requirePermission("schedules:write") },
    handlers.create
  );

  app.patch(
    "/schedules/:id",
    { preHandler: requirePermission("schedules:write") },
    handlers.update
  );

  app.delete(
    "/schedules/:id",
    { preHandler: requirePermission("schedules:write") },
    handlers.remove
  );
}
