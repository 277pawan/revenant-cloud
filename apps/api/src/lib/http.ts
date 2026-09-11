import type { FastifyReply, FastifyRequest } from "fastify";
import { isAppError } from "./errors.js";

/** Shared handler error response — function-based, no controller base class */
export function sendHandlerError(
  err: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
  fallback: string
) {
  if (isAppError(err)) {
    return reply.status(err.statusCode).send({ error: err.message, code: err.code });
  }
  request.log.error(err);
  return reply.status(500).send({ error: fallback, code: "INTERNAL" });
}
