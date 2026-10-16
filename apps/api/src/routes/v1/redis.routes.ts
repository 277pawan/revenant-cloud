import type { FastifyInstance } from "fastify";
import type { RedisHandlers } from "../../controllers/redis.controller.js";
import { requirePermission } from "../../middleware/auth.js";

/**
 * Redis provider routes.
 *
 * Permissions map onto the existing database permissions rather than new ones:
 * Redis is a recovery resource, so `databases:*` and `credentials:write` already
 * mean the right thing and no RBAC migration is needed.
 */
export async function redisRoutes(app: FastifyInstance, handlers: RedisHandlers) {
  /**
   * Test an unsaved URL. Read-scoped because it changes nothing — it only
   * returns whether Revenant can reach the Redis and a redacted fingerprint.
   */
  app.post(
    "/redis/test",
    { preHandler: requirePermission("databases:read") },
    handlers.test
  );

  app.get(
    "/redis",
    { preHandler: requirePermission("databases:read") },
    handlers.list
  );

  app.post(
    "/redis",
    { preHandler: requirePermission("credentials:write") },
    handlers.create
  );

  app.get(
    "/redis/:id",
    { preHandler: requirePermission("databases:read") },
    handlers.get
  );

  app.patch(
    "/redis/:id",
    { preHandler: requirePermission("credentials:write") },
    handlers.update
  );

  app.delete(
    "/redis/:id",
    { preHandler: requirePermission("credentials:write") },
    handlers.remove
  );

  app.post(
    "/redis/:id/proofs",
    { preHandler: requirePermission("jobs:run") },
    handlers.startProof
  );

  app.get(
    "/redis/:id/proofs",
    { preHandler: requirePermission("databases:read") },
    handlers.listProofs
  );

  app.delete(
    "/redis/snapshots/:id",
    { preHandler: requirePermission("credentials:write") },
    handlers.deleteSnapshot
  );
}