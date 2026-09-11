import type { FastifyReply, FastifyRequest } from "fastify";
import {
  inviteTeamMemberSchema,
  teamMemberIdParamSchema,
  updateTeamMemberSchema,
} from "../validations/team.schema.js";
import { paginationQuerySchema } from "../validations/pagination.schema.js";
import type { TeamService } from "../services/team.service.js";
import { sendHandlerError } from "../lib/http.js";

export function createTeamHandlers(teamService: TeamService) {
  return {
    list: async (request: FastifyRequest, reply: FastifyReply) => {
      const query = paginationQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply
          .status(400)
          .send({ error: "Invalid pagination", code: "VALIDATION_ERROR" });
      }

      try {
        return await teamService.list(request.user.organizationId, query.data);
      } catch (err) {
        return sendHandlerError(
          err,
          request,
          reply,
          "Failed to list team members"
        );
      }
    },

    invite: async (request: FastifyRequest, reply: FastifyReply) => {
      const body = inviteTeamMemberSchema.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({
          error: "Invalid request",
          code: "VALIDATION_ERROR",
          details: body.error.flatten().fieldErrors,
        });
      }

      try {
        const member = await teamService.invite(
          request.user.organizationId,
          body.data
        );
        return reply.status(201).send({ member });
      } catch (err) {
        return sendHandlerError(
          err,
          request,
          reply,
          "Failed to invite team member"
        );
      }
    },

    update: async (request: FastifyRequest, reply: FastifyReply) => {
      const params = teamMemberIdParamSchema.safeParse(request.params);
      if (!params.success) {
        return reply
          .status(400)
          .send({ error: "Invalid member id", code: "VALIDATION_ERROR" });
      }

      const body = updateTeamMemberSchema.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({
          error: "Invalid request",
          code: "VALIDATION_ERROR",
          details: body.error.flatten().fieldErrors,
        });
      }

      try {
        const member = await teamService.updateRole(
          request.user.organizationId,
          params.data.id,
          request.user.id,
          body.data
        );
        return { member };
      } catch (err) {
        return sendHandlerError(
          err,
          request,
          reply,
          "Failed to update team member"
        );
      }
    },

    remove: async (request: FastifyRequest, reply: FastifyReply) => {
      const params = teamMemberIdParamSchema.safeParse(request.params);
      if (!params.success) {
        return reply
          .status(400)
          .send({ error: "Invalid member id", code: "VALIDATION_ERROR" });
      }

      try {
        await teamService.remove(
          request.user.organizationId,
          params.data.id,
          request.user.id
        );
        return reply.status(204).send();
      } catch (err) {
        return sendHandlerError(
          err,
          request,
          reply,
          "Failed to remove team member"
        );
      }
    },
  };
}

export type TeamHandlers = ReturnType<typeof createTeamHandlers>;
