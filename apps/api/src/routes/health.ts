import type { FastifyInstance } from "fastify";
import type { HealthResponse } from "@revenant/shared";
import { inArray, sql } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { jobs } from "../db/schema.js";
import { getObservabilitySnapshot, setActiveJobs } from "../lib/observability.js";

const VERSION = "0.0.1";

/** Unversioned liveness probe (load balancers / k8s). */
export async function rootHealthRoutes(app: FastifyInstance, db: Database) {
  app.get("/health", async (): Promise<HealthResponse> => ({
    status: "ok",
    service: "revenant-api",
    version: VERSION,
    environment: process.env.NODE_ENV,
  }));

  app.get("/metrics", async () => {
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(jobs)
      .where(inArray(jobs.status, ["pending", "running"]));
    setActiveJobs(row?.count ?? 0);
    return getObservabilitySnapshot();
  });
}
