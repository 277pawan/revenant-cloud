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
import { createAuthHandlers } from "./controllers/auth.controller.js";
import { createDatabasesHandlers } from "./controllers/databases.controller.js";
import { createPlansHandlers } from "./controllers/plans.controller.js";
import { createTeamHandlers } from "./controllers/team.controller.js";
import { createJobsHandlers } from "./controllers/jobs.controller.js";
import { createRunnersHandlers } from "./controllers/runners.controller.js";
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

  await rootHealthRoutes(app);
  await registerV1Routes(app, {
    authHandlers: createAuthHandlers(createAuthService(db, env)),
    databasesHandlers: createDatabasesHandlers(
      createDatabasesService(db, env.MASTER_KEY)
    ),
    plansHandlers: createPlansHandlers(createPlansService(db)),
    teamHandlers: createTeamHandlers(createTeamService(db)),
    jobsHandlers: createJobsHandlers(createJobsService(db, env.MASTER_KEY)),
    runnersHandlers: createRunnersHandlers(createRunnersService(db)),
    env,
    db,
  });

  return app;
}
