import type { FastifyReply, FastifyRequest } from "fastify";
import { paginationQuerySchema } from "../validations/pagination.schema.js";
import {
  createWebhookSchema,
  updateWebhookSchema,
  webhookIdParamSchema,
} from "../validations/webhooks.schema.js";
import type { WebhooksService } from "../services/webhooks.service.js";
import type { AuditService } from "../services/audit.service.js";
import { sendHandlerError } from "../lib/http.js";

export function createWebhooksHandlers(
  webhooksService: WebhooksService,
  auditService: AuditService
) {
  return {
    listProviders: async (_request: FastifyRequest, _reply: FastifyReply) => {
      return webhooksService.listProviders();
    },

    list: async (request: FastifyRequest, reply: FastifyReply) => {
      const query = paginationQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply
          .status(400)
          .send({ error: "Invalid pagination", code: "VALIDATION_ERROR" });
      }

      try {
        return await webhooksService.list(
          request.user.organizationId,
          query.data
        );
      } catch (err) {
        return sendHandlerError(err, request, reply, "Failed to list webhooks");
      }
    },

    create: async (request: FastifyRequest, reply: FastifyReply) => {
      const body = createWebhookSchema.safeParse(request.body);
      if (!body.success) {
        return reply
          .status(400)
          .send({ error: "Invalid webhook", code: "VALIDATION_ERROR" });
      }

      try {
        const result = await webhooksService.create(
          request.user.organizationId,
          body.data
        );
        await auditService.log({
          organizationId: request.user.organizationId,
          actorUserId: request.user.id,
          action: "webhook.create",
          resourceType: "webhook",
          resourceId: result.endpoint.id,
          metadata: {
            name: result.endpoint.name,
            provider: result.endpoint.provider,
          },
        });
        return reply.status(201).send(result);
      } catch (err) {
        return sendHandlerError(err, request, reply, "Failed to create webhook");
      }
    },

    update: async (request: FastifyRequest, reply: FastifyReply) => {
      const params = webhookIdParamSchema.safeParse(request.params);
      if (!params.success) {
        return reply
          .status(400)
          .send({ error: "Invalid webhook id", code: "VALIDATION_ERROR" });
      }

      const body = updateWebhookSchema.safeParse(request.body);
      if (!body.success) {
        return reply
          .status(400)
          .send({ error: "Invalid webhook", code: "VALIDATION_ERROR" });
      }

      try {
        const endpoint = await webhooksService.update(
          request.user.organizationId,
          params.data.id,
          body.data
        );
        await auditService.log({
          organizationId: request.user.organizationId,
          actorUserId: request.user.id,
          action: "webhook.update",
          resourceType: "webhook",
          resourceId: endpoint.id,
        });
        return { endpoint };
      } catch (err) {
        return sendHandlerError(err, request, reply, "Failed to update webhook");
      }
    },

    remove: async (request: FastifyRequest, reply: FastifyReply) => {
      const params = webhookIdParamSchema.safeParse(request.params);
      if (!params.success) {
        return reply
          .status(400)
          .send({ error: "Invalid webhook id", code: "VALIDATION_ERROR" });
      }

      try {
        await webhooksService.remove(
          request.user.organizationId,
          params.data.id
        );
        await auditService.log({
          organizationId: request.user.organizationId,
          actorUserId: request.user.id,
          action: "webhook.delete",
          resourceType: "webhook",
          resourceId: params.data.id,
        });
        return reply.status(204).send();
      } catch (err) {
        return sendHandlerError(err, request, reply, "Failed to delete webhook");
      }
    },
  };
}

export type WebhooksHandlers = ReturnType<typeof createWebhooksHandlers>;
