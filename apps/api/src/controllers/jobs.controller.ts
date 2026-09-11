import type { FastifyReply, FastifyRequest } from "fastify";
import {
  completeJobSchema,
  createJobSchema,
  jobIdParamSchema,
} from "../validations/jobs.schema.js";
import { paginationQuerySchema } from "../validations/pagination.schema.js";
import type { JobsService } from "../services/jobs.service.js";
import { sendHandlerError } from "../lib/http.js";

export function createJobsHandlers(jobsService: JobsService) {
  return {
    list: async (request: FastifyRequest, reply: FastifyReply) => {
      const query = paginationQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply
          .status(400)
          .send({ error: "Invalid pagination", code: "VALIDATION_ERROR" });
      }

      try {
        return await jobsService.list(request.user.organizationId, query.data);
      } catch (err) {
        return sendHandlerError(err, request, reply, "Failed to list jobs");
      }
    },

    get: async (request: FastifyRequest, reply: FastifyReply) => {
      const params = jobIdParamSchema.safeParse(request.params);
      if (!params.success) {
        return reply
          .status(400)
          .send({ error: "Invalid job id", code: "VALIDATION_ERROR" });
      }

      try {
        const job = await jobsService.getById(
          request.user.organizationId,
          params.data.id
        );
        return { job };
      } catch (err) {
        return sendHandlerError(err, request, reply, "Failed to get job");
      }
    },

    create: async (request: FastifyRequest, reply: FastifyReply) => {
      const body = createJobSchema.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({
          error: "Invalid request",
          code: "VALIDATION_ERROR",
          details: body.error.flatten().fieldErrors,
        });
      }

      try {
        const job = await jobsService.create(
          request.user.organizationId,
          request.user.id,
          body.data
        );
        return reply.status(201).send({ job });
      } catch (err) {
        return sendHandlerError(err, request, reply, "Failed to create job");
      }
    },

    claim: async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.runnerAuth) {
        return reply
          .status(401)
          .send({ error: "Unauthorized runner", code: "UNAUTHORIZED" });
      }

      try {
        const claimed = await jobsService.claimNext(request.runnerAuth);
        if (!claimed) {
          return reply.status(204).send();
        }
        return claimed;
      } catch (err) {
        return sendHandlerError(err, request, reply, "Failed to claim job");
      }
    },

    complete: async (request: FastifyRequest, reply: FastifyReply) => {
      const params = jobIdParamSchema.safeParse(request.params);
      if (!params.success) {
        return reply
          .status(400)
          .send({ error: "Invalid job id", code: "VALIDATION_ERROR" });
      }

      const body = completeJobSchema.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({
          error: "Invalid request",
          code: "VALIDATION_ERROR",
          details: body.error.flatten().fieldErrors,
        });
      }

      try {
        const job = await jobsService.complete(
          params.data.id,
          body.data,
          request.runnerAuth
        );
        return { job };
      } catch (err) {
        return sendHandlerError(err, request, reply, "Failed to complete job");
      }
    },
  };
}

export type JobsHandlers = ReturnType<typeof createJobsHandlers>;
