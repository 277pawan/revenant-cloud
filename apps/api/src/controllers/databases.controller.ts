import type { FastifyReply, FastifyRequest } from "fastify";
import {
  createDatabaseSchema,
  databaseIdParamSchema,
  updateDatabaseSchema,
} from "../validations/databases.schema.js";
import { paginationQuerySchema } from "../validations/pagination.schema.js";
import type { DatabasesService } from "../services/databases.service.js";
import { isAppError } from "../lib/errors.js";

export class DatabasesController {
  constructor(private databasesService: DatabasesService) {}

  list = async (request: FastifyRequest, reply: FastifyReply) => {
    const query = paginationQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.status(400).send({ error: "Invalid pagination", code: "VALIDATION_ERROR" });
    }

    try {
      return await this.databasesService.list(
        request.user.organizationId,
        query.data
      );
    } catch (err) {
      return this.handleError(err, request, reply, "Failed to list databases");
    }
  };

  get = async (request: FastifyRequest, reply: FastifyReply) => {
    const params = databaseIdParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: "Invalid database id", code: "VALIDATION_ERROR" });
    }

    try {
      const database = await this.databasesService.getById(
        request.user.organizationId,
        params.data.id
      );
      return { database };
    } catch (err) {
      return this.handleError(err, request, reply, "Failed to get database");
    }
  };

  create = async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = createDatabaseSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid request",
        code: "VALIDATION_ERROR",
        details: parsed.error.flatten().fieldErrors,
      });
    }

    try {
      const database = await this.databasesService.create(
        request.user.organizationId,
        parsed.data
      );
      return reply.status(201).send({ database });
    } catch (err) {
      return this.handleError(err, request, reply, "Failed to create database");
    }
  };

  update = async (request: FastifyRequest, reply: FastifyReply) => {
    const params = databaseIdParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: "Invalid database id", code: "VALIDATION_ERROR" });
    }

    const parsed = updateDatabaseSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid request",
        code: "VALIDATION_ERROR",
        details: parsed.error.flatten().fieldErrors,
      });
    }

    try {
      const database = await this.databasesService.update(
        request.user.organizationId,
        params.data.id,
        parsed.data
      );
      return { database };
    } catch (err) {
      return this.handleError(err, request, reply, "Failed to update database");
    }
  };

  remove = async (request: FastifyRequest, reply: FastifyReply) => {
    const params = databaseIdParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: "Invalid database id", code: "VALIDATION_ERROR" });
    }

    try {
      await this.databasesService.delete(request.user.organizationId, params.data.id);
      return reply.status(204).send();
    } catch (err) {
      return this.handleError(err, request, reply, "Failed to delete database");
    }
  };

  private handleError(
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
}
