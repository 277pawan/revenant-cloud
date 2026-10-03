import type { FastifyReply, FastifyRequest } from "fastify";
import type { SettingsService } from "../services/settings.service.js";
import type { AuditService } from "../services/audit.service.js";
import { updateOrganizationSchema } from "../validations/settings.schema.js";
import { sendHandlerError } from "../lib/http.js";

export function createSettingsHandlers(
  settingsService: SettingsService,
  auditService: AuditService
) {
  return {
    getOrganization: async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const organization = await settingsService.getOrganization(
          request.user.organizationId
        );
        return { organization };
      } catch (err) {
        return sendHandlerError(err, request, reply, "Failed to load organization");
      }
    },

    updateOrganization: async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = updateOrganizationSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "Invalid request",
          code: "VALIDATION_ERROR",
          details: parsed.error.flatten().fieldErrors,
        });
      }

      try {
        const organization = await settingsService.updateOrganization(
          request.user.organizationId,
          parsed.data
        );
        await auditService.log({
          organizationId: request.user.organizationId,
          actorUserId: request.user.id,
          action: "organization.updated",
          resourceType: "organization",
          resourceId: organization.id,
          metadata: { name: organization.name },
        });
        request.auditEventRecorded = true;
        return { organization };
      } catch (err) {
        return sendHandlerError(err, request, reply, "Failed to update organization");
      }
    },
  };
}

export type SettingsHandlers = ReturnType<typeof createSettingsHandlers>;
