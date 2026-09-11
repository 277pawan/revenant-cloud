import Fastify from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import jwt from "@fastify/jwt";
import type { Env } from "./config/env.js";
import { createDb } from "./db/index.js";
import { rootHealthRoutes } from "./routes/health.js";
import { registerV1Routes } from "./routes/v1/index.js";
import { createAuthService } from "./services/auth.service.js";
import { createDatabasesService } from "./services/databases.service.js";
import { createPlansService } from "./services/plans.service.js";
import { createTeamService } from "./services/team.service.js";
import { createJobsService } from "./services/jobs.service.js";
import { createRunnersService } from "./services/runners.service.js";
import { createSchedulesService } from "./services/schedules.service.js";
import { createEvidenceService } from "./services/evidence.service.js";
import { createWebhooksService } from "./services/webhooks.service.js";
import { createAuditService } from "./services/audit.service.js";
import { createAuthHandlers } from "./controllers/auth.controller.js";
import { createDatabasesHandlers } from "./controllers/databases.controller.js";
import { createPlansHandlers } from "./controllers/plans.controller.js";
import { createTeamHandlers } from "./controllers/team.controller.js";
import { createJobsHandlers } from "./controllers/jobs.controller.js";
import { createRunnersHandlers } from "./controllers/runners.controller.js";
import { createSchedulesHandlers } from "./controllers/schedules.controller.js";
import { createEvidenceHandlers } from "./controllers/evidence.controller.js";
import { createWebhooksHandlers } from "./controllers/webhooks.controller.js";
import { createAuditHandlers } from "./controllers/audit.controller.js";
import { SESSION_COOKIE } from "./lib/session.js";
import type { AuthUser } from "@revenant/shared";
import type { Database } from "./db/index.js";

declare module "fastify" {
  interface FastifyInstance {
    config: Env;
    db: Database;
  }
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: AuthUser;
    user: AuthUser;
  }
}

export async function buildApp(env: Env) {
  const app = Fastify({
    logger: env.NODE_ENV === "development",
  });

  app.decorate("config", env);

  await app.register(cors, {
    origin: env.CORS_ORIGIN,
    credentials: true,
  });

  await app.register(cookie);

  await app.register(jwt, {
    secret: env.JWT_SECRET,
    cookie: {
      cookieName: SESSION_COOKIE,
      signed: false,
    },
  });

  const db = createDb(env.DATABASE_URL);
  app.decorate("db", db);

  const jobsService = createJobsService(db, env.MASTER_KEY);
  const auditService = createAuditService(db);
  const evidenceService = createEvidenceService(db, env.EVIDENCE_DIR);
  const webhooksService = createWebhooksService(db, env.MASTER_KEY);

  await rootHealthRoutes(app);
  await registerV1Routes(app, {
    authHandlers: createAuthHandlers(createAuthService(db, env)),
    databasesHandlers: createDatabasesHandlers(
      createDatabasesService(db, env.MASTER_KEY)
    ),
    plansHandlers: createPlansHandlers(createPlansService(db)),
    teamHandlers: createTeamHandlers(createTeamService(db)),
    jobsHandlers: createJobsHandlers(
      jobsService,
      evidenceService,
      webhooksService,
      auditService
    ),
    runnersHandlers: createRunnersHandlers(createRunnersService(db)),
    schedulesHandlers: createSchedulesHandlers(
      createSchedulesService(db),
      auditService
    ),
    evidenceHandlers: createEvidenceHandlers(evidenceService),
    webhooksHandlers: createWebhooksHandlers(webhooksService, auditService),
    auditHandlers: createAuditHandlers(auditService),
    env,
    db,
    jobsService,
  });

  return app;
}
