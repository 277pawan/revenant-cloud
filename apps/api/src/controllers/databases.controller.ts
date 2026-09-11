import type { FastifyReply, FastifyRequest } from "fastify";
import {
  createDatabaseSchema,
  databaseIdParamSchema,
  updateDatabaseSchema,
} from "../validations/databases.schema.js";
import { databasesListQuerySchema } from "../validations/databases.schema.js";
import type { DatabasesService } from "../services/databases.service.js";
import { sendHandlerError } from "../lib/http.js";

export function createDatabasesHandlers(databasesService: DatabasesService) {
  return {
    list: async (request: FastifyRequest, reply: FastifyReply) => {
      const query = databasesListQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply
          .status(400)
          .send({ error: "Invalid pagination", code: "VALIDATION_ERROR" });
      }

      try {
        return await databasesService.list(
          request.user.organizationId,
          query.data
        );
      } catch (err) {
        return sendHandlerError(err, request, reply, "Failed to list databases");
      }
    },

    get: async (request: FastifyRequest, reply: FastifyReply) => {
      const params = databaseIdParamSchema.safeParse(request.params);
      if (!params.success) {
        return reply
          .status(400)
          .send({ error: "Invalid database id", code: "VALIDATION_ERROR" });
      }

      try {
        const database = await databasesService.getById(
          request.user.organizationId,
          params.data.id
        );
        return { database };
      } catch (err) {
        return sendHandlerError(err, request, reply, "Failed to get database");
      }
    },

    create: async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = createDatabaseSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "Invalid request",
          code: "VALIDATION_ERROR",
          details: parsed.error.flatten().fieldErrors,
        });
      }

      try {
        const database = await databasesService.create(
          request.user.organizationId,
          parsed.data
        );
        return reply.status(201).send({ database });
      } catch (err) {
        return sendHandlerError(err, request, reply, "Failed to create database");
      }
    },

    update: async (request: FastifyRequest, reply: FastifyReply) => {
      const params = databaseIdParamSchema.safeParse(request.params);
      if (!params.success) {
        return reply
          .status(400)
          .send({ error: "Invalid database id", code: "VALIDATION_ERROR" });
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
        const database = await databasesService.update(
          request.user.organizationId,
          params.data.id,
          parsed.data
        );
        return { database };
      } catch (err) {
        return sendHandlerError(err, request, reply, "Failed to update database");
      }
    },

    remove: async (request: FastifyRequest, reply: FastifyReply) => {
      const params = databaseIdParamSchema.safeParse(request.params);
      if (!params.success) {
        return reply
          .status(400)
          .send({ error: "Invalid database id", code: "VALIDATION_ERROR" });
      }

      try {
        await databasesService.delete(
          request.user.organizationId,
          params.data.id
        );
        return reply.status(204).send();
      } catch (err) {
        return sendHandlerError(err, request, reply, "Failed to delete database");
      }
    },
  };
}

export type DatabasesHandlers = ReturnType<typeof createDatabasesHandlers>;
