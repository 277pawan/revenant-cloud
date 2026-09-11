import type { FastifyInstance } from "fastify";
import type { WebhooksHandlers } from "../../controllers/webhooks.controller.js";
import { requirePermission } from "../../middleware/auth.js";

export async function webhooksRoutes(
  app: FastifyInstance,
  handlers: WebhooksHandlers
) {
  app.get(
    "/webhooks/providers",
    { preHandler: requirePermission("webhooks:read") },
    handlers.listProviders
  );

  app.get(
    "/webhooks",
    { preHandler: requirePermission("webhooks:read") },
    handlers.list
  );

  app.post(
    "/webhooks",
    { preHandler: requirePermission("webhooks:write") },
    handlers.create
  );

  app.patch(
    "/webhooks/:id",
    { preHandler: requirePermission("webhooks:write") },
    handlers.update
  );

  app.delete(
    "/webhooks/:id",
    { preHandler: requirePermission("webhooks:write") },
    handlers.remove
  );
}
