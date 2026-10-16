import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "../../db/index.js";
import type { Env } from "../../config/env.js";
import { redisProofs } from "../../db/schema.js";
import { requireRunner } from "../../middleware/runner.js";
import { completeRedisProofSchema } from "../../validations/redis-proof.schema.js";
import {
  claimNextRedisProof,
  completeRedisProofRun,
} from "../../services/redis-snapshots.service.js";

const proofIdParamSchema = z.object({ id: z.string().uuid() });

/**
 * Agent endpoints for the Redis restore proof.
 *
 * These sit behind the same runner token as the job claim endpoint (see the
 * auth preHandler applied by the caller), because they need to return the
 * decrypted Redis URL — exactly like the existing runner claim returns
 * decrypted database credentials.
 *
 * `POST /runner/redis-proofs/claim` returns 204 when there is nothing to do,
 * matching the shape of `/runner/claim` so agents can share a poll pattern.
 */
export async function runnerRedisRoutes(
  app: FastifyInstance,
  deps: { db: Database; masterKey: string; env: Env }
) {
  const runnerAuth = requireRunner(deps.env, deps.db);

  app.post(
    "/runner/redis-proofs/claim",
    { preHandler: runnerAuth },
    async (_request, reply) => {
      const claim = await claimNextRedisProof(deps.db, deps.masterKey);
      if (!claim) {
        return reply.status(204).send();
      }
      // NOTE: `redisUrl` is a live secret. It is returned here and nowhere
      // else, and the agent must never log it — redactRedisUrl exists for that.
      return { claim };
    }
  );

  app.post(
    "/runner/redis-proofs/:id/complete",
    { preHandler: runnerAuth },
    async (request, reply) => {
      const params = proofIdParamSchema.safeParse(request.params);
      if (!params.success) {
        return reply
          .status(400)
          .send({ error: "Invalid proof id", code: "VALIDATION_ERROR" });
      }
      const body = completeRedisProofSchema.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({
          error: "Invalid proof result",
          code: "VALIDATION_ERROR",
          details: body.error.flatten(),
        });
      }

      const result = body.data;

      // The runner token is org-agnostic by design (it is not a user session),
      // so the org comes from the proof row itself.
      const [row] = await deps.db
        .select({ organizationId: redisProofs.organizationId })
        .from(redisProofs)
        .where(eq(redisProofs.id, params.data.id))
        .limit(1);
      if (!row) {
        return reply.status(404).send({ error: "Proof not found", code: "NOT_FOUND" });
      }

      await completeRedisProofRun(deps.db, row.organizationId, params.data.id, {
        restored: result.restored,
        sourceKeyCount: result.sourceKeyCount,
        restoredKeyCount: result.restoredKeyCount,
        rdbBytes: result.rdbBytes,
        restoreSeconds: result.restoreSeconds,
        rpoObservedSeconds: result.rpoObservedSeconds,
        rdbLastBgsaveStatus: result.rdbLastBgsaveStatus,
        metadata: result.metadata,
        errorMessage: result.errorMessage,
        rdbBase64: result.rdbBase64,
      });

      return reply.status(204).send();
    }
  );
}