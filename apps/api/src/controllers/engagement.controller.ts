import type { FastifyReply, FastifyRequest } from "fastify";
import { engagementTrackSchema } from "../validations/engagement.schema.js";
import type { EngagementService } from "../services/engagement.service.js";
import { sendHandlerError } from "../lib/http.js";
import { createAppError } from "../lib/errors.js";

export function createEngagementHandlers(engagementService: EngagementService) {
  return {
    track: async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const parsed = engagementTrackSchema.safeParse(request.body);
        if (!parsed.success) {
          throw createAppError(400, "Invalid engagement payload", "VALIDATION_ERROR");
        }
        // Prefer JWT user when present (optional auth)
        let userId = parsed.data.userId;
        let userEmail = parsed.data.userEmail;
        try {
          await request.jwtVerify();
          userId = request.user.id;
          userEmail = request.user.email;
        } catch {
          /* anonymous ok */
        }
        const result = await engagementService.track({
          ...parsed.data,
          userId,
          userEmail,
        });
        return reply.status(201).send(result);
      } catch (err) {
        return sendHandlerError(err, request, reply, "Could not track event");
      }
    },

    publicCounters: async (
      request: FastifyRequest<{ Querystring: { site?: string } }>,
      reply: FastifyReply
    ) => {
      try {
        const site = request.query.site === "app" ? "app" : "marketing";
        return engagementService.publicCounters(site);
      } catch (err) {
        return sendHandlerError(err, request, reply, "Could not load counters");
      }
    },

    stats: async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        return engagementService.stats();
      } catch (err) {
        return sendHandlerError(err, request, reply, "Could not load engagement stats");
      }
    },
  };
}

export type EngagementHandlers = ReturnType<typeof createEngagementHandlers>;
