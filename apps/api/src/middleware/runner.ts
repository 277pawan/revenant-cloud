import type { FastifyReply, FastifyRequest } from "fastify";
import type { Env } from "../config/env.js";

/** Runner auth via Authorization: Bearer <RUNNER_TOKEN> */
export function requireRunner(env: Env) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = request.headers.authorization;
    if (!auth?.startsWith("Bearer ") || auth.slice(7) !== env.RUNNER_TOKEN) {
      return reply.status(401).send({ error: "Unauthorized runner", code: "UNAUTHORIZED" });
    }
  };
}
