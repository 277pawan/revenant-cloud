import type { FastifyReply, FastifyRequest } from "fastify";
import { and, eq, isNull } from "drizzle-orm";
import type { Env } from "../config/env.js";
import type { Database } from "../db/index.js";
import { runners } from "../db/schema.js";
import { hashRunnerToken } from "../lib/runner-token.js";

export type RunnerAuthContext =
  | { type: "stub"; organizationId: null; databaseId: null }
  | {
      type: "org";
      organizationId: string;
      runnerId: string;
      databaseId: string;
      kind: "agent" | "ci";
    };

declare module "fastify" {
  interface FastifyRequest {
    runnerAuth?: RunnerAuthContext;
  }
}

/**
 * Accepts either:
 * - global RUNNER_TOKEN → stub (any org, marked simulated)
 * - org runner token (rvn_…) → claims only that org's jobs
 */
export function requireRunner(env: Env, db: Database) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = request.headers.authorization;
    if (!auth?.startsWith("Bearer ")) {
      return reply.status(401).send({ error: "Unauthorized runner", code: "UNAUTHORIZED" });
    }

    const token = auth.slice(7);

    if (token === env.RUNNER_TOKEN) {
      request.runnerAuth = { type: "stub", organizationId: null, databaseId: null };
      return;
    }

    const hash = hashRunnerToken(token);
    const rows = await db
      .select()
      .from(runners)
      .where(and(eq(runners.tokenHash, hash), isNull(runners.revokedAt)))
      .limit(1);

    if (!rows[0]) {
      return reply.status(401).send({ error: "Unauthorized runner", code: "UNAUTHORIZED" });
    }

    if (!rows[0].databaseId) {
      return reply.status(401).send({
        error: "Runner is not linked to a validation plan. Re-issue token from Settings.",
        code: "RUNNER_NO_DATABASE",
      });
    }

    const kind = rows[0].kind === "ci" ? "ci" : "agent";
    request.runnerAuth = {
      type: "org",
      organizationId: rows[0].organizationId,
      runnerId: rows[0].id,
      databaseId: rows[0].databaseId,
      kind,
    };

    await db
      .update(runners)
      .set({ lastSeenAt: new Date() })
      .where(eq(runners.id, rows[0].id));
  };
}
