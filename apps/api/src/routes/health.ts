import type { FastifyInstance } from "fastify";
import type { HealthResponse } from "@revenant/shared";

const VERSION = "0.0.1";

/** Unversioned liveness probe (load balancers / k8s). */
export async function rootHealthRoutes(app: FastifyInstance) {
  app.get("/health", async (): Promise<HealthResponse> => ({
    status: "ok",
    service: "revenant-api",
    version: VERSION,
    environment: process.env.NODE_ENV,
  }));
}
