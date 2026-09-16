import type { FastifyInstance } from "fastify";
import type { AuthHandlers } from "../../controllers/auth.controller.js";
import type { DatabasesHandlers } from "../../controllers/databases.controller.js";
import type { PlansHandlers } from "../../controllers/plans.controller.js";
import type { TeamHandlers } from "../../controllers/team.controller.js";
import type { JobsHandlers } from "../../controllers/jobs.controller.js";
import type { RunnersHandlers } from "../../controllers/runners.controller.js";
import type { SchedulesHandlers } from "../../controllers/schedules.controller.js";
import type { EvidenceHandlers } from "../../controllers/evidence.controller.js";
import type { WebhooksHandlers } from "../../controllers/webhooks.controller.js";
import type { AuditHandlers } from "../../controllers/audit.controller.js";
import type { DashboardHandlers } from "../../controllers/dashboard.controller.js";
import type { PublicHandlers } from "../../controllers/public.controller.js";
import type { BillingHandlers } from "../../controllers/billing.controller.js";
import type { Env } from "../../config/env.js";
import type { Database } from "../../db/index.js";
import type { JobsService } from "../../services/jobs.service.js";
import { authRoutes } from "./auth.routes.js";
import { databasesRoutes } from "./databases.routes.js";
import { healthRoutes } from "./health.routes.js";
import { plansRoutes } from "./plans.routes.js";
import { teamRoutes } from "./team.routes.js";
import { jobsRoutes } from "./jobs.routes.js";
import { runnersRoutes } from "./runners.routes.js";
import { schedulesRoutes } from "./schedules.routes.js";
import { evidenceRoutes } from "./evidence.routes.js";
import { webhooksRoutes } from "./webhooks.routes.js";
import { auditRoutes } from "./audit.routes.js";
import { dashboardRoutes } from "./dashboard.routes.js";
import { publicRoutes } from "./public.routes.js";
import { billingRoutes } from "./billing.routes.js";

export async function registerV1Routes(
  app: FastifyInstance,
  deps: {
    authHandlers: AuthHandlers;
    databasesHandlers: DatabasesHandlers;
    plansHandlers: PlansHandlers;
    teamHandlers: TeamHandlers;
    jobsHandlers: JobsHandlers;
    runnersHandlers: RunnersHandlers;
    schedulesHandlers: SchedulesHandlers;
    evidenceHandlers: EvidenceHandlers;
    webhooksHandlers: WebhooksHandlers;
    auditHandlers: AuditHandlers;
    dashboardHandlers: DashboardHandlers;
    publicHandlers: PublicHandlers;
    billingHandlers: BillingHandlers;
    env: Env;
    db: Database;
    jobsService: JobsService;
  }
) {
  await app.register(
    async (api) => {
      await healthRoutes(api);
      await publicRoutes(api, deps.publicHandlers);
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
      await schedulesRoutes(api, deps.schedulesHandlers);
      await evidenceRoutes(api, deps.evidenceHandlers);
      await webhooksRoutes(api, deps.webhooksHandlers);
      await auditRoutes(api, deps.auditHandlers);
      await dashboardRoutes(api, deps.dashboardHandlers);
      await billingRoutes(api, deps.billingHandlers);
    },
    { prefix: "/api/v1" }
  );
}
