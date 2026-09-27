import type { FastifyReply, FastifyRequest } from "fastify";
import { databaseIdParamSchema } from "../validations/databases.schema.js";
import { z } from "zod";
import type { RecoveryPointsService } from "../services/recovery-points.service.js";
import { sendHandlerError } from "../lib/http.js";

const recoveryPointIdParamSchema = z.object({ id: z.string().uuid() });
const recoveryPointsQuerySchema = z.object({ includeDeleted: z.enum(["true", "false"]).optional() });
const recoverBodySchema = z.object({
  targetIdentifier: z.string().trim().min(1).max(63).regex(/^[a-z][a-z0-9-]*$/i),
  confirmTargetIdentifier: z.string().min(1).max(63),
  dbSubnetGroupName: z.string().trim().min(1).max(255).optional(),
  vpcSecurityGroupIds: z.array(z.string().regex(/^sg-[a-f0-9]+$/i)).min(1).max(5).optional(),
  instanceClass: z.string().trim().max(50).optional(),
  resolveOnly: z.boolean().optional(),
});

export function createRecoveryPointsHandlers(
  recoveryPointsService: RecoveryPointsService
) {
  return {
    listForDatabase: async (request: FastifyRequest, reply: FastifyReply) => {
      const params = databaseIdParamSchema.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({ error: "Invalid database id", code: "VALIDATION_ERROR" });
      }
      const query = recoveryPointsQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.status(400).send({ error: "Invalid recovery point filters", code: "VALIDATION_ERROR" });
      }
      try {
        const recoveryPoints = await recoveryPointsService.listForDatabase(
          request.user.organizationId,
          params.data.id,
          query.data.includeDeleted === "true"
        );
        return { recoveryPoints };
      } catch (err) {
        return sendHandlerError(err, request, reply, "Failed to list recovery points");
      }
    },

    get: async (request: FastifyRequest, reply: FastifyReply) => {
      const params = recoveryPointIdParamSchema.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({ error: "Invalid recovery point id", code: "VALIDATION_ERROR" });
      }
      try {
        const recoveryPoint = await recoveryPointsService.getById(
          request.user.organizationId,
          params.data.id
        );
        const runs = await recoveryPointsService.listRuns(
          request.user.organizationId,
          params.data.id
        );
        return { recoveryPoint, runs };
      } catch (err) {
        return sendHandlerError(err, request, reply, "Failed to get recovery point");
      }
    },

    verifyAgain: async (request: FastifyRequest, reply: FastifyReply) => {
      const params = recoveryPointIdParamSchema.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({ error: "Invalid recovery point id", code: "VALIDATION_ERROR" });
      }
      try {
        const result = await recoveryPointsService.verifyAgain(
          request.user.organizationId,
          request.user.id,
          params.data.id
        );
        return reply.status(201).send(result);
      } catch (err) {
        return sendHandlerError(err, request, reply, "Failed to start verification");
      }
    },

    deleteSnapshot: async (request: FastifyRequest, reply: FastifyReply) => {
      const params = recoveryPointIdParamSchema.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({ error: "Invalid recovery point id", code: "VALIDATION_ERROR" });
      }
      try {
        const result = await recoveryPointsService.deleteSnapshot(
          request.user.organizationId,
          params.data.id
        );
        return reply.status(200).send(result);
      } catch (err) {
        return sendHandlerError(err, request, reply, "Could not delete AWS snapshot");
      }
    },

    recover: async (request: FastifyRequest, reply: FastifyReply) => {
      const params = recoveryPointIdParamSchema.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({ error: "Invalid recovery point id", code: "VALIDATION_ERROR" });
      }
      const body = recoverBodySchema.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({
          error: body.error.issues[0]?.message ?? "Invalid recovery configuration",
          code: "VALIDATION_ERROR",
        });
      }
      try {
        const result = await recoveryPointsService.recoverFromPoint(
          request.user.organizationId,
          params.data.id,
          body.data
        );
        return reply.status(202).send(result);
      } catch (err) {
        return sendHandlerError(err, request, reply, "Recovery not available yet");
      }
    },

    listRecoveryInstances: async (request: FastifyRequest, reply: FastifyReply) => {
      const params = recoveryPointIdParamSchema.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({ error: "Invalid recovery point id", code: "VALIDATION_ERROR" });
      }
      try {
        const instances = await recoveryPointsService.listRecoveryInstances(
          request.user.organizationId,
          params.data.id
        );
        return { instances };
      } catch (err) {
        return sendHandlerError(err, request, reply, "Failed to list recovered instances");
      }
    },
  };
}

export type RecoveryPointsHandlers = ReturnType<typeof createRecoveryPointsHandlers>;
