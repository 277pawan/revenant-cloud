import type { FastifyInstance } from "fastify";
import type { JobsController } from "../../controllers/jobs.controller.js";
import { requirePermission } from "../../middleware/auth.js";
import { requireRunner } from "../../middleware/runner.js";
import type { Env } from "../../config/env.js";

export async function jobsRoutes(
  app: FastifyInstance,
  controller: JobsController,
  env: Env
) {
  app.get(
    "/jobs",
    { preHandler: requirePermission("jobs:read") },
    controller.list
  );

  app.get(
    "/jobs/:id",
    { preHandler: requirePermission("jobs:read") },
    controller.get
  );

  app.post(
    "/jobs",
    { preHandler: requirePermission("jobs:run") },
    controller.create
  );

  // Runner endpoints — Bearer RUNNER_TOKEN (not user JWT)
  app.post(
    "/runner/claim",
    { preHandler: requireRunner(env) },
    controller.claim
  );

  app.post(
    "/runner/jobs/:id/complete",
    { preHandler: requireRunner(env) },
    controller.complete
  );
}
