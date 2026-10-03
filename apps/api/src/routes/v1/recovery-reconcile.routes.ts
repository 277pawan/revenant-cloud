import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Database } from "../../db/index.js";
import { reconcileTemporaryRecoveryResources } from "../../services/recovery-reconciler.service.js";

function matchesBearerToken(header: string | undefined, expectedToken: string): boolean {
  const actual = Buffer.from(header?.replace(/^Bearer\s+/i, "") ?? "");
  const expected = Buffer.from(expectedToken);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function recoveryReconcileRoutes(
  app: FastifyInstance,
  db: Database,
  masterKey: string
) {
  app.post("/internal/recovery/reconcile", async (request, reply) => {
    const token = process.env.RECOVERY_RECONCILE_TOKEN?.trim();
    if (!token) {
      return reply.code(503).send({
        error: "Recovery reconciliation is not configured",
      });
    }
    if (!matchesBearerToken(request.headers.authorization, token)) {
      return reply.code(401).send({ error: "Unauthorized" });
    }

    const summary = await reconcileTemporaryRecoveryResources(db, masterKey);
    return reply.code(summary.errors.length > 0 ? 207 : 200).send(summary);
  });
}
