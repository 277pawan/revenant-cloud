import type { FastifyInstance } from "fastify";
import type { AuthController } from "../../controllers/auth.controller.js";
import type { DatabasesController } from "../../controllers/databases.controller.js";
import type { PlansController } from "../../controllers/plans.controller.js";
import type { TeamController } from "../../controllers/team.controller.js";
import type { JobsController } from "../../controllers/jobs.controller.js";
import type { Env } from "../../config/env.js";
import { authRoutes } from "./auth.routes.js";
import { databasesRoutes } from "./databases.routes.js";
import { healthRoutes } from "./health.routes.js";
import { plansRoutes } from "./plans.routes.js";
import { teamRoutes } from "./team.routes.js";
import { jobsRoutes } from "./jobs.routes.js";

/**
 * All versioned API routes live under /api/v1.
 * To ship v2 later: create routes/v2/ and register with prefix "/api/v2".
 */
export async function registerV1Routes(
  app: FastifyInstance,
  deps: {
    authController: AuthController;
    databasesController: DatabasesController;
    plansController: PlansController;
    teamController: TeamController;
    jobsController: JobsController;
    env: Env;
  }
) {
  await app.register(
    async (api) => {
      await healthRoutes(api);
      await authRoutes(api, deps.authController);
      await databasesRoutes(api, deps.databasesController);
      await plansRoutes(api, deps.plansController);
      await teamRoutes(api, deps.teamController);
      await jobsRoutes(api, deps.jobsController, deps.env);
    },
    { prefix: "/api/v1" }
  );
}
