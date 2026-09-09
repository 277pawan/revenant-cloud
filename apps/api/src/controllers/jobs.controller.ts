import type { FastifyReply, FastifyRequest } from "fastify";
import {
  completeJobSchema,
  createJobSchema,
  jobIdParamSchema,
} from "../validations/jobs.schema.js";
import { paginationQuerySchema } from "../validations/pagination.schema.js";
import type { JobsService } from "../services/jobs.service.js";
import { isAppError } from "../lib/errors.js";

export class JobsController {
  constructor(private jobsService: JobsService) {}

  list = async (request: FastifyRequest, reply: FastifyReply) => {
    const query = paginationQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.status(400).send({ error: "Invalid pagination", code: "VALIDATION_ERROR" });
    }

    try {
      return await this.jobsService.list(request.user.organizationId, query.data);
    } catch (err) {
      return this.handleError(err, request, reply, "Failed to list jobs");
    }
  };

  get = async (request: FastifyRequest, reply: FastifyReply) => {
    const params = jobIdParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: "Invalid job id", code: "VALIDATION_ERROR" });
    }

    try {
      const job = await this.jobsService.getById(
        request.user.organizationId,
        params.data.id
      );
      return { job };
    } catch (err) {
      return this.handleError(err, request, reply, "Failed to get job");
    }
  };

  create = async (request: FastifyRequest, reply: FastifyReply) => {
    const body = createJobSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({
        error: "Invalid request",
        code: "VALIDATION_ERROR",
        details: body.error.flatten().fieldErrors,
      });
    }

    try {
      const job = await this.jobsService.create(
        request.user.organizationId,
        request.user.id,
        body.data
      );
      return reply.status(201).send({ job });
    } catch (err) {
      return this.handleError(err, request, reply, "Failed to create job");
    }
  };

  claim = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const claimed = await this.jobsService.claimNext();
      if (!claimed) {
        return reply.status(204).send();
      }
      return claimed;
    } catch (err) {
      return this.handleError(err, request, reply, "Failed to claim job");
    }
  };

  complete = async (request: FastifyRequest, reply: FastifyReply) => {
    const params = jobIdParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: "Invalid job id", code: "VALIDATION_ERROR" });
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
      const job = await this.jobsService.complete(params.data.id, body.data);
      return { job };
    } catch (err) {
      return this.handleError(err, request, reply, "Failed to complete job");
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
