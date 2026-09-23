import type { FastifyReply, FastifyRequest } from "fastify";
import { databaseIdParamSchema } from "../validations/databases.schema.js";
import { jobIdParamSchema } from "../validations/jobs.schema.js";
import { upsertRecoveryContractSchema } from "../validations/recovery-contract.schema.js";
import type { RecoveryContractService } from "../services/recovery-contract.service.js";
import type { RecoveryDriftService } from "../services/recovery-drift.service.js";
import type { RecoveryReadinessService } from "../services/recovery-readiness.service.js";
import type { RecoveryPassportService } from "../services/recovery-passport.service.js";
import type { createRecoveryChallengesService } from "../services/recovery-challenges.service.js";
import type { createReadinessSnapshotService } from "../services/readiness-snapshot.service.js";
import type { JobsService } from "../services/jobs.service.js";
import { renderPassportPdf } from "../lib/passport-pdf.js";
import { sendHandlerError } from "../lib/http.js";
import { z } from "zod";

const challengeBodySchema = z.object({
  name: z.string().min(1).max(255),
  strategy: z.enum(["latest", "days_ago"]),
  daysAgo: z.number().int().min(1).max(365).optional(),
});

const challengeIdParamSchema = z.object({ challengeId: z.string().uuid() });

export function createRecoveryHandlers(deps: {
  contractService: RecoveryContractService;
  readinessService: RecoveryReadinessService;
  driftService: RecoveryDriftService;
  passportService: RecoveryPassportService;
  challengesService: ReturnType<typeof createRecoveryChallengesService>;
  snapshotService: ReturnType<typeof createReadinessSnapshotService>;
  jobsService: JobsService;
  organizationsLookup: (orgId: string) => Promise<string>;
}) {
  return {
    getContract: async (request: FastifyRequest, reply: FastifyReply) => {
      const params = databaseIdParamSchema.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({ error: "Invalid database id", code: "VALIDATION_ERROR" });
      }
      try {
        const contract = await deps.contractService.get(
          request.user.organizationId,
          params.data.id
        );
        return { contract };
      } catch (err) {
        return sendHandlerError(err, request, reply, "Failed to get recovery contract");
      }
    },

    upsertContract: async (request: FastifyRequest, reply: FastifyReply) => {
      const params = databaseIdParamSchema.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({ error: "Invalid database id", code: "VALIDATION_ERROR" });
      }
      const body = upsertRecoveryContractSchema.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({
          error: "Invalid recovery contract",
          code: "VALIDATION_ERROR",
          details: body.error.flatten().fieldErrors,
        });
      }
      try {
        const contract = await deps.contractService.upsert(
          request.user.organizationId,
          params.data.id,
          body.data
        );
        return { contract };
      } catch (err) {
        return sendHandlerError(err, request, reply, "Failed to save recovery contract");
      }
    },

    getReadiness: async (request: FastifyRequest, reply: FastifyReply) => {
      const params = databaseIdParamSchema.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({ error: "Invalid database id", code: "VALIDATION_ERROR" });
      }
      try {
        const readiness = await deps.readinessService.getForDatabase(
          request.user.organizationId,
          params.data.id
        );
        return { readiness };
      } catch (err) {
        return sendHandlerError(err, request, reply, "Failed to get recovery readiness");
      }
    },

    getDrift: async (request: FastifyRequest, reply: FastifyReply) => {
      const params = databaseIdParamSchema.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({ error: "Invalid database id", code: "VALIDATION_ERROR" });
      }
      try {
        const events = await deps.driftService.listOpen(
          request.user.organizationId,
          params.data.id
        );
        return { drift: { events } };
      } catch (err) {
        return sendHandlerError(err, request, reply, "Failed to get recovery drift");
      }
    },

    getReadinessHistory: async (request: FastifyRequest, reply: FastifyReply) => {
      const params = databaseIdParamSchema.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({ error: "Invalid database id", code: "VALIDATION_ERROR" });
      }
      try {
        const history = await deps.snapshotService.getHistory(
          request.user.organizationId,
          params.data.id
        );
        return { history };
      } catch (err) {
        return sendHandlerError(err, request, reply, "Failed to load readiness history");
      }
    },

    listChallenges: async (request: FastifyRequest, reply: FastifyReply) => {
      const params = databaseIdParamSchema.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({ error: "Invalid database id", code: "VALIDATION_ERROR" });
      }
      try {
        const challenges = await deps.challengesService.list(
          request.user.organizationId,
          params.data.id
        );
        return { challenges };
      } catch (err) {
        return sendHandlerError(err, request, reply, "Failed to list challenges");
      }
    },

    createChallenge: async (request: FastifyRequest, reply: FastifyReply) => {
      const params = databaseIdParamSchema.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({ error: "Invalid database id", code: "VALIDATION_ERROR" });
      }
      const body = challengeBodySchema.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: "Invalid challenge", code: "VALIDATION_ERROR" });
      }
      try {
        const challenge = await deps.challengesService.create(
          request.user.organizationId,
          params.data.id,
          body.data
        );
        return reply.status(201).send({ challenge });
      } catch (err) {
        return sendHandlerError(err, request, reply, "Failed to create challenge");
      }
    },

    updateChallenge: async (request: FastifyRequest, reply: FastifyReply) => {
      const params = challengeIdParamSchema.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({ error: "Invalid challenge id", code: "VALIDATION_ERROR" });
      }
      const body = challengeBodySchema.partial().extend({ enabled: z.boolean().optional() }).safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: "Invalid challenge", code: "VALIDATION_ERROR" });
      }
      try {
        const challenge = await deps.challengesService.update(
          request.user.organizationId,
          params.data.challengeId,
          body.data
        );
        return { challenge };
      } catch (err) {
        return sendHandlerError(err, request, reply, "Failed to update challenge");
      }
    },

    deleteChallenge: async (request: FastifyRequest, reply: FastifyReply) => {
      const params = challengeIdParamSchema.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({ error: "Invalid challenge id", code: "VALIDATION_ERROR" });
      }
      try {
        await deps.challengesService.remove(
          request.user.organizationId,
          params.data.challengeId
        );
        return reply.status(204).send();
      } catch (err) {
        return sendHandlerError(err, request, reply, "Failed to delete challenge");
      }
    },

    runChallenge: async (request: FastifyRequest, reply: FastifyReply) => {
      const params = challengeIdParamSchema.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({ error: "Invalid challenge id", code: "VALIDATION_ERROR" });
      }
      try {
        const result = await deps.challengesService.run(
          request.user.organizationId,
          request.user.id,
          params.data.challengeId
        );
        return reply.status(201).send(result);
      } catch (err) {
        return sendHandlerError(err, request, reply, "Failed to run challenge");
      }
    },

    downloadPassport: async (request: FastifyRequest, reply: FastifyReply) => {
      const params = jobIdParamSchema.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({ error: "Invalid job id", code: "VALIDATION_ERROR" });
      }
      try {
        const job = await deps.jobsService.getById(
          request.user.organizationId,
          params.data.id
        );
        const body = await deps.passportService.getPassportBody(
          request.user.organizationId,
          job
        );
        return reply
          .header("Content-Type", "application/json")
          .header(
            "Content-Disposition",
            `attachment; filename="recovery-passport-${params.data.id}.json"`
          )
          .send(body);
      } catch (err) {
        return sendHandlerError(err, request, reply, "Failed to download recovery passport");
      }
    },

    downloadPassportPdf: async (request: FastifyRequest, reply: FastifyReply) => {
      const params = jobIdParamSchema.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({ error: "Invalid job id", code: "VALIDATION_ERROR" });
      }
      try {
        const job = await deps.jobsService.getById(
          request.user.organizationId,
          params.data.id
        );
        const body = await deps.passportService.getPassportBody(
          request.user.organizationId,
          job
        );
        const passport = JSON.parse(body) as import("../services/recovery-passport.service.js").RecoveryPassportDocument;
        const orgName = await deps.organizationsLookup(request.user.organizationId);
        const pdf = await renderPassportPdf({ passport, organizationName: orgName });
        return reply
          .header("Content-Type", "application/pdf")
          .header(
            "Content-Disposition",
            `attachment; filename="recovery-passport-${params.data.id}.pdf"`
          )
          .send(pdf);
      } catch (err) {
        return sendHandlerError(err, request, reply, "Failed to download passport PDF");
      }
    },
  };
}

export type RecoveryHandlers = ReturnType<typeof createRecoveryHandlers>;
