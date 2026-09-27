import type { FastifyInstance } from "fastify";
import type { RecoveryHandlers } from "../../controllers/recovery.controller.js";
import type { RecoveryPointsHandlers } from "../../controllers/recovery-points.controller.js";
import { requirePermission } from "../../middleware/auth.js";

export async function recoveryRoutes(
  app: FastifyInstance,
  handlers: RecoveryHandlers,
  recoveryPointsHandlers: RecoveryPointsHandlers
) {
  app.get(
    "/databases/:id/recovery-contract",
    { preHandler: requirePermission("databases:read") },
    handlers.getContract
  );

  app.put(
    "/databases/:id/recovery-contract",
    { preHandler: requirePermission("plans:write") },
    handlers.upsertContract
  );

  app.get(
    "/databases/:id/readiness",
    { preHandler: requirePermission("databases:read") },
    handlers.getReadiness
  );

  app.get(
    "/databases/:id/recovery-gate",
    { preHandler: requirePermission("databases:read") },
    handlers.getRecoveryGate
  );

  app.get(
    "/databases/:id/drift",
    { preHandler: requirePermission("databases:read") },
    handlers.getDrift
  );

  app.get(
    "/jobs/:id/passport",
    { preHandler: requirePermission("evidence:read") },
    handlers.downloadPassport
  );

  app.get(
    "/jobs/:id/passport/pdf",
    { preHandler: requirePermission("evidence:read") },
    handlers.downloadPassportPdf
  );

  app.get(
    "/databases/:id/readiness/history",
    { preHandler: requirePermission("databases:read") },
    handlers.getReadinessHistory
  );

  app.get(
    "/databases/:id/challenges",
    { preHandler: requirePermission("databases:read") },
    handlers.listChallenges
  );

  app.post(
    "/databases/:id/challenges",
    { preHandler: requirePermission("jobs:run") },
    handlers.createChallenge
  );

  app.patch(
    "/challenges/:challengeId",
    { preHandler: requirePermission("jobs:run") },
    handlers.updateChallenge
  );

  app.delete(
    "/challenges/:challengeId",
    { preHandler: requirePermission("jobs:run") },
    handlers.deleteChallenge
  );

  app.post(
    "/challenges/:challengeId/run",
    { preHandler: requirePermission("jobs:run") },
    handlers.runChallenge
  );

  app.get(
    "/databases/:id/recovery-points",
    { preHandler: requirePermission("databases:read") },
    recoveryPointsHandlers.listForDatabase
  );

  app.get(
    "/recovery-points/:id",
    { preHandler: requirePermission("databases:read") },
    recoveryPointsHandlers.get
  );

  app.post(
    "/recovery-points/:id/verify",
    { preHandler: requirePermission("jobs:run") },
    recoveryPointsHandlers.verifyAgain
  );

  app.delete(
    "/recovery-points/:id",
    { preHandler: requirePermission("jobs:run") },
    recoveryPointsHandlers.deleteSnapshot
  );

  app.post(
    "/recovery-points/:id/recover",
    { preHandler: requirePermission("jobs:run") },
    recoveryPointsHandlers.recover
  );

  app.get(
    "/recovery-points/:id/instances",
    { preHandler: requirePermission("databases:read") },
    recoveryPointsHandlers.listRecoveryInstances
  );
}
