import type { FastifyReply, FastifyRequest } from "fastify";
import { paginationQuerySchema } from "../validations/pagination.schema.js";
import {
  createScheduleSchema,
  scheduleIdParamSchema,
  updateScheduleSchema,
} from "../validations/schedules.schema.js";
import type { SchedulesService } from "../services/schedules.service.js";
import { sendHandlerError } from "../lib/http.js";

export function createSchedulesHandlers(schedulesService: SchedulesService) {
  return {
    list: async (request: FastifyRequest, reply: FastifyReply) => {
      const query = paginationQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply
          .status(400)
          .send({ error: "Invalid pagination", code: "VALIDATION_ERROR" });
      }

      try {
        return await schedulesService.list(
          request.user.organizationId,
          query.data
        );
      } catch (err) {
        return sendHandlerError(err, request, reply, "Failed to list schedules");
      }
    },

    create: async (request: FastifyRequest, reply: FastifyReply) => {
      const body = createScheduleSchema.safeParse(request.body);
      if (!body.success) {
        return reply
          .status(400)
          .send({ error: "Invalid schedule", code: "VALIDATION_ERROR" });
      }

      try {
        const schedule = await schedulesService.create(
          request.user.organizationId,
          body.data
        );
        return reply.status(201).send({ schedule });
      } catch (err) {
        return sendHandlerError(err, request, reply, "Failed to create schedule");
      }
    },

    update: async (request: FastifyRequest, reply: FastifyReply) => {
      const params = scheduleIdParamSchema.safeParse(request.params);
      if (!params.success) {
        return reply
          .status(400)
          .send({ error: "Invalid schedule id", code: "VALIDATION_ERROR" });
      }

      const body = updateScheduleSchema.safeParse(request.body);
      if (!body.success) {
        return reply
          .status(400)
          .send({ error: "Invalid schedule", code: "VALIDATION_ERROR" });
      }

      try {
        const schedule = await schedulesService.update(
          request.user.organizationId,
          params.data.id,
          body.data
        );
        return { schedule };
      } catch (err) {
        return sendHandlerError(err, request, reply, "Failed to update schedule");
      }
    },

    remove: async (request: FastifyRequest, reply: FastifyReply) => {
      const params = scheduleIdParamSchema.safeParse(request.params);
      if (!params.success) {
        return reply
          .status(400)
          .send({ error: "Invalid schedule id", code: "VALIDATION_ERROR" });
      }

      try {
        await schedulesService.remove(
          request.user.organizationId,
          params.data.id
        );
        return reply.status(204).send();
      } catch (err) {
        return sendHandlerError(err, request, reply, "Failed to delete schedule");
      }
    },
  };
}

export type SchedulesHandlers = ReturnType<typeof createSchedulesHandlers>;
