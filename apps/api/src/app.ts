import Fastify from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import jwt from "@fastify/jwt";
import type { Env } from "./config/env.js";
import { createDb } from "./db/index.js";
import { rootHealthRoutes } from "./routes/health.js";
import { registerV1Routes } from "./routes/v1/index.js";
import { createAuthService } from "./services/auth.service.js";
import { createAuthProvidersService } from "./services/auth-providers.service.js";
import { createDatabasesService } from "./services/databases.service.js";
import { createPlansService } from "./services/plans.service.js";
import { createYamlComposerService } from "./services/yaml-composer.service.js";
import { createTeamService } from "./services/team.service.js";
import { createJobsService } from "./services/jobs.service.js";
import { createRunnersService } from "./services/runners.service.js";
import { createSchedulesService } from "./services/schedules.service.js";
import { createEvidenceService } from "./services/evidence.service.js";
import { createWebhooksService } from "./services/webhooks.service.js";
import { createAuditService } from "./services/audit.service.js";
import { createAuthHandlers } from "./controllers/auth.controller.js";
import { createDatabasesHandlers } from "./controllers/databases.controller.js";
import { createRecoveryContractService } from "./services/recovery-contract.service.js";
import { createRecoveryReadinessService } from "./services/recovery-readiness.service.js";
import { createRecoveryFingerprintService } from "./services/recovery-fingerprint.service.js";
import { createRecoveryDriftService } from "./services/recovery-drift.service.js";
import { createRecoveryPassportService } from "./services/recovery-passport.service.js";
import { createRecoveryChallengesService } from "./services/recovery-challenges.service.js";
import { createReadinessSnapshotService } from "./services/readiness-snapshot.service.js";
import { createRecoveryPostProcessService } from "./services/recovery-post-process.service.js";
import { createRecoveryHandlers } from "./controllers/recovery.controller.js";
import { createRecoveryPointsHandlers } from "./controllers/recovery-points.controller.js";
import { createRecoveryPointsService } from "./services/recovery-points.service.js";
import { generateCorrelationId, recordRequest } from "./lib/observability.js";
import { createPlansHandlers } from "./controllers/plans.controller.js";
import { createTeamHandlers } from "./controllers/team.controller.js";
import { createJobsHandlers } from "./controllers/jobs.controller.js";
import { createRunnersHandlers } from "./controllers/runners.controller.js";
import { createSchedulesHandlers } from "./controllers/schedules.controller.js";
import { createEvidenceHandlers } from "./controllers/evidence.controller.js";
import { createWebhooksHandlers } from "./controllers/webhooks.controller.js";
import { createAuditHandlers } from "./controllers/audit.controller.js";
import { createDashboardHandlers } from "./controllers/dashboard.controller.js";
import { createPublicHandlers } from "./controllers/public.controller.js";
import { createContactHandlers } from "./controllers/contact.controller.js";
import { createFundingHandlers } from "./controllers/funding.controller.js";
import { createContactService } from "./services/contact.service.js";
import { createFundingService } from "./services/funding.service.js";
import { createEngagementHandlers } from "./controllers/engagement.controller.js";
import { createEngagementService } from "./services/engagement.service.js";
import { createBillingHandlers } from "./controllers/billing.controller.js";
import { createSettingsHandlers } from "./controllers/settings.controller.js";
import { createSettingsService } from "./services/settings.service.js";
import { createDashboardService } from "./services/dashboard.service.js";
import { createBillingService } from "./services/billing.service.js";
import { SESSION_COOKIE } from "./lib/session.js";
import { isAllowedCorsOrigin, parseCorsOrigins } from "./lib/cors-origins.js";
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

  const corsOrigins = parseCorsOrigins(env.CORS_ORIGIN);
  await app.register(cors, {
    origin: (origin, cb) => {
      cb(null, isAllowedCorsOrigin(origin, corsOrigins));
    },
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
  const webhooksService = createWebhooksService(db, env.MASTER_KEY, env);
  const recoveryContractService = createRecoveryContractService(db);
  const recoveryReadinessService = createRecoveryReadinessService(db);
  const recoveryFingerprintService = createRecoveryFingerprintService(db);
  const recoveryDriftService = createRecoveryDriftService(db);
  const recoveryPassportService = createRecoveryPassportService(
    db,
    env.EVIDENCE_DIR,
    env.MASTER_KEY
  );
  const readinessSnapshotService = createReadinessSnapshotService(
    db,
    recoveryReadinessService
  );
  const recoveryChallengesService = createRecoveryChallengesService(db);
  const recoveryPointsService = createRecoveryPointsService(db, jobsService, env.MASTER_KEY);
  const settingsService = createSettingsService(db);
  const recoveryPostProcessService = createRecoveryPostProcessService(db, {
    fingerprintService: recoveryFingerprintService,
    driftService: recoveryDriftService,
    passportService: recoveryPassportService,
    snapshotService: readinessSnapshotService,
    recoveryPointsService,
  });

  app.addHook("onRequest", async (request) => {
    const incoming = request.headers["x-correlation-id"];
    const correlationId =
      typeof incoming === "string" && incoming.trim()
        ? incoming.trim()
        : generateCorrelationId();
    request.headers["x-correlation-id"] = correlationId;
  });

  app.addHook("onResponse", async (_request, reply) => {
    recordRequest(reply.statusCode);
  });

  await rootHealthRoutes(app, db);
  const authProvidersService = createAuthProvidersService(db, env);
  await registerV1Routes(app, {
    authHandlers: createAuthHandlers(
      createAuthService(db, env),
      authProvidersService,
      env
    ),
    databasesHandlers: createDatabasesHandlers(
      createDatabasesService(db, env.MASTER_KEY),
      recoveryContractService
    ),
    recoveryPointsHandlers: createRecoveryPointsHandlers(recoveryPointsService),
    recoveryHandlers: createRecoveryHandlers({
      contractService: recoveryContractService,
      readinessService: recoveryReadinessService,
      driftService: recoveryDriftService,
      passportService: recoveryPassportService,
      challengesService: recoveryChallengesService,
      snapshotService: readinessSnapshotService,
      jobsService,
      organizationsLookup: async (orgId) => {
        const org = await settingsService.getOrganization(orgId);
        return org.name;
      },
    }),
    plansHandlers: createPlansHandlers(
      createPlansService(db),
      createYamlComposerService(env),
      recoveryDriftService
    ),
    teamHandlers: createTeamHandlers(createTeamService(db, env)),
    jobsHandlers: createJobsHandlers(
      jobsService,
      evidenceService,
      webhooksService,
      auditService,
      recoveryPostProcessService
    ),
    runnersHandlers: createRunnersHandlers(createRunnersService(db)),
    schedulesHandlers: createSchedulesHandlers(
      createSchedulesService(db),
      auditService
    ),
    evidenceHandlers: createEvidenceHandlers(evidenceService),
    webhooksHandlers: createWebhooksHandlers(webhooksService, auditService),
    auditHandlers: createAuditHandlers(auditService),
    dashboardHandlers: createDashboardHandlers(
      createDashboardService(db),
      readinessSnapshotService
    ),
    publicHandlers: createPublicHandlers(env, authProvidersService),
    contactHandlers: createContactHandlers(createContactService(db, env)),
    fundingHandlers: createFundingHandlers(createFundingService(db, env)),
    engagementHandlers: createEngagementHandlers(createEngagementService(db)),
    billingHandlers: createBillingHandlers(
      createBillingService(db, env),
      auditService
    ),
    settingsHandlers: createSettingsHandlers(settingsService, auditService),
    env,
    db,
    jobsService,
  });

  return app;
}
