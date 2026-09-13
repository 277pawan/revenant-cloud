import type { FastifyInstance } from "fastify";
import type { PublicHandlers } from "../../controllers/public.controller.js";

export async function publicRoutes(
  app: FastifyInstance,
  handlers: PublicHandlers
) {
  app.get("/public/catalog", handlers.catalog);
}
