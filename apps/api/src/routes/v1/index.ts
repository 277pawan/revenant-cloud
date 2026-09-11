import type { FastifyInstance } from "fastify";
import type { AuthHandlers } from "../../controllers/auth.controller.js";
import type { DatabasesHandlers } from "../../controllers/databases.controller.js";
import type { PlansHandlers } from "../../controllers/plans.controller.js";
import type { TeamHandlers } from "../../controllers/team.controller.js";
import type { JobsHandlers } from "../../controllers/jobs.controller.js";
import type { RunnersHandlers } from "../../controllers/runners.controller.js";
import type { Env } from "../../config/env.js";
import type { Database } from "../../db/index.js";
import { authRoutes } from "./auth.routes.js";
import { databasesRoutes } from "./databases.routes.js";
import { healthRoutes } from "./health.routes.js";
import { plansRoutes } from "./plans.routes.js";
import { teamRoutes } from "./team.routes.js";
import { jobsRoutes } from "./jobs.routes.js";
import { runnersRoutes } from "./runners.routes.js";

export async function registerV1Routes(
  app: FastifyInstance,
  deps: {
    authHandlers: AuthHandlers;
    databasesHandlers: DatabasesHandlers;
    plansHandlers: PlansHandlers;
    teamHandlers: TeamHandlers;
    jobsHandlers: JobsHandlers;
    runnersHandlers: RunnersHandlers;
    env: Env;
    db: Database;
  }
) {
  await app.register(
    async (api) => {
      await healthRoutes(api);
      await authRoutes(api, deps.authHandlers);
      await databasesRoutes(api, deps.databasesHandlers);
      await plansRoutes(api, deps.plansHandlers);
      await teamRoutes(api, deps.teamHandlers);
      await jobsRoutes(
        api,
        deps.jobsHandlers,
        deps.runnersHandlers,
        deps.env,
        deps.db
      );
      await runnersRoutes(api, deps.runnersHandlers);
    },
    { prefix: "/api/v1" }
  );
}
