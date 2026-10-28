import type { FastifyReply, FastifyRequest } from "fastify";
import { isAppError } from "./errors.js";
import { isMissingDatabaseObjectError, migrationRequiredMessage } from "./pg-errors.js";

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
  if (isMissingDatabaseObjectError(err)) {
    const message = migrationRequiredMessage(fallback, err);
    request.log.error({ err }, "Missing database object; required migration is not applied");
    return reply
      .status(503)
      .send({ error: message, code: "MIGRATION_REQUIRED" });
  }
  request.log.error(err);
  return reply.status(500).send({ error: fallback, code: "INTERNAL" });
}
