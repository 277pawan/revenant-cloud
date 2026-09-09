import Fastify from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import jwt from "@fastify/jwt";
import type { Env } from "./config/env.js";
import { createDb } from "./db/index.js";
import { rootHealthRoutes } from "./routes/health.js";
import { registerV1Routes } from "./routes/v1/index.js";
import { AuthService } from "./services/auth.service.js";
import { DatabasesService } from "./services/databases.service.js";
import { PlansService } from "./services/plans.service.js";
import { TeamService } from "./services/team.service.js";
import { JobsService } from "./services/jobs.service.js";
import { AuthController } from "./controllers/auth.controller.js";
import { DatabasesController } from "./controllers/databases.controller.js";
import { PlansController } from "./controllers/plans.controller.js";
import { TeamController } from "./controllers/team.controller.js";
import { JobsController } from "./controllers/jobs.controller.js";
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

  const authService = new AuthService(db, env);
  const databasesService = new DatabasesService(db, env.MASTER_KEY);
  const plansService = new PlansService(db);
  const teamService = new TeamService(db);
  const jobsService = new JobsService(db, env.MASTER_KEY);

  await rootHealthRoutes(app);
  await registerV1Routes(app, {
    authController: new AuthController(authService),
    databasesController: new DatabasesController(databasesService),
    plansController: new PlansController(plansService),
    teamController: new TeamController(teamService),
    jobsController: new JobsController(jobsService),
    env,
  });

  return app;
}
