import type { FastifyReply, FastifyRequest } from "fastify";
import {
  completeJobSchema,
  createJobSchema,
  jobIdParamSchema,
} from "../validations/jobs.schema.js";
import { paginationQuerySchema } from "../validations/pagination.schema.js";
import type { JobsService } from "../services/jobs.service.js";
import type { EvidenceService } from "../services/evidence.service.js";
import type { WebhooksService } from "../services/webhooks.service.js";
import type { AuditService } from "../services/audit.service.js";
import { sendHandlerError } from "../lib/http.js";
import type { EvidenceArtifactResource } from "@revenant/shared";

async function ensureJobEvidence(
  organizationId: string,
  jobId: string,
  jobsService: JobsService,
  evidenceService: EvidenceService,
  reply: FastifyReply
): Promise<EvidenceArtifactResource | null> {
  let artifact = await evidenceService.getByJobId(organizationId, jobId);

  if (!artifact) {
    const job = await jobsService.getById(organizationId, jobId);
    if (!["pass", "fail", "error"].includes(job.status)) {
      await reply.status(404).send({
        error: "Report is available after the run finishes",
        code: "NOT_READY",
      });
      return null;
    }
    await evidenceService.archiveFromJob(organizationId, job);
    artifact = await evidenceService.getByJobId(organizationId, jobId);
  }

  if (!artifact) {
    await reply.status(404).send({ error: "Evidence not found", code: "NOT_FOUND" });
    return null;
  }

  return artifact;
}

export function createJobsHandlers(
  jobsService: JobsService,
  evidenceService: EvidenceService,
  webhooksService: WebhooksService,
  auditService: AuditService
) {
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
        await auditService.log({
          organizationId: request.user.organizationId,
          actorUserId: request.user.id,
          action: "job.create",
          resourceType: "job",
          resourceId: job.id,
          metadata: {
            databaseId: job.databaseId,
            trigger: job.trigger,
            drillKind: body.data.drillKind,
          },
        });
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

        const orgId =
          request.runnerAuth?.type === "org"
            ? request.runnerAuth.organizationId
            : await jobsService.getOrganizationId(job.id);

        const detail = await jobsService.getById(orgId, job.id);
        await evidenceService.archiveFromJob(orgId, detail);
        await webhooksService.dispatchForJob(orgId, detail);

        return { job };
      } catch (err) {
        return sendHandlerError(err, request, reply, "Failed to complete job");
      }
    },

    downloadEvidence: async (request: FastifyRequest, reply: FastifyReply) => {
      const params = jobIdParamSchema.safeParse(request.params);
      if (!params.success) {
        return reply
          .status(400)
          .send({ error: "Invalid job id", code: "VALIDATION_ERROR" });
      }

      const orgId = request.user.organizationId;

      try {
        const artifact = await ensureJobEvidence(
          orgId,
          params.data.id,
          jobsService,
          evidenceService,
          reply
        );
        if (!artifact) return;

        const { body, artifact: row } = await evidenceService.getDownload(
          orgId,
          artifact.id
        );
        return reply
          .header("Content-Type", "application/json")
          .header(
            "Content-Disposition",
            `attachment; filename="revenant-report-${row.jobId}.json"`
          )
          .send(body);
      } catch (err) {
        return sendHandlerError(err, request, reply, "Failed to download report");
      }
    },

    downloadEvidencePdf: async (request: FastifyRequest, reply: FastifyReply) => {
      const params = jobIdParamSchema.safeParse(request.params);
      if (!params.success) {
        return reply
          .status(400)
          .send({ error: "Invalid job id", code: "VALIDATION_ERROR" });
      }

      const orgId = request.user.organizationId;

      try {
        const artifact = await ensureJobEvidence(
          orgId,
          params.data.id,
          jobsService,
          evidenceService,
          reply
        );
        if (!artifact) return;

        const { pdf, artifact: row } = await evidenceService.getPdf(orgId, artifact.id);
        return reply
          .header("Content-Type", "application/pdf")
          .header(
            "Content-Disposition",
            `attachment; filename="revenant-evidence-${row.jobId}.pdf"`
          )
          .send(pdf);
      } catch (err) {
        return sendHandlerError(err, request, reply, "Failed to download PDF");
      }
    },
  };
}

export type JobsHandlers = ReturnType<typeof createJobsHandlers>;
