import type { FastifyInstance } from "fastify";
import type { JobsHandlers } from "../../controllers/jobs.controller.js";
import type { RunnersHandlers } from "../../controllers/runners.controller.js";
import { requirePermission } from "../../middleware/auth.js";
import { requireRunner } from "../../middleware/runner.js";
import type { Env } from "../../config/env.js";
import type { Database } from "../../db/index.js";

export async function jobsRoutes(
  app: FastifyInstance,
  handlers: JobsHandlers,
  runnersHandlers: RunnersHandlers,
  env: Env,
  db: Database
) {
  app.get(
    "/jobs",
    { preHandler: requirePermission("jobs:read") },
    handlers.list
  );

  app.get(
    "/jobs/:id",
    { preHandler: requirePermission("jobs:read") },
    handlers.get
  );

  app.get(
    "/jobs/:id/evidence/download",
    { preHandler: requirePermission("evidence:read") },
    handlers.downloadEvidence
  );

  app.post(
    "/jobs",
    { preHandler: requirePermission("jobs:run") },
    handlers.create
  );

  const runnerAuth = requireRunner(env, db);

  app.get("/runner/whoami", { preHandler: runnerAuth }, runnersHandlers.whoami);
  app.post("/runner/claim", { preHandler: runnerAuth }, handlers.claim);
  app.post(
    "/runner/jobs/:id/complete",
    { preHandler: runnerAuth },
    handlers.complete
  );
}
