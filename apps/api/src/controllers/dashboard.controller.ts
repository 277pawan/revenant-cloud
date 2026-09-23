import type { FastifyReply, FastifyRequest } from "fastify";
import type { DashboardService } from "../services/dashboard.service.js";
import type { createReadinessSnapshotService } from "../services/readiness-snapshot.service.js";
import { sendHandlerError } from "../lib/http.js";

export function createDashboardHandlers(
  dashboardService: DashboardService,
  snapshotService: ReturnType<typeof createReadinessSnapshotService>
) {
  return {
    overview: async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const overview = await dashboardService.getOverview(
          request.user.organizationId
        );
        return { overview };
      } catch (err) {
        return sendHandlerError(err, request, reply, "Failed to load dashboard");
      }
    },

    rtoTrends: async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const trends = await dashboardService.getRtoTrends(
          request.user.organizationId
        );
        return { trends };
      } catch (err) {
        return sendHandlerError(err, request, reply, "Failed to load RTO trends");
      }
    },

    rpoTrends: async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const trends = await snapshotService.getRpoTrends(request.user.organizationId);
        return { trends };
      } catch (err) {
        return sendHandlerError(err, request, reply, "Failed to load RPO trends");
      }
    },
  };
}

export type DashboardHandlers = ReturnType<typeof createDashboardHandlers>;
