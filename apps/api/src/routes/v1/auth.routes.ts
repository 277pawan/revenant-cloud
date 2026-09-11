import type { FastifyInstance } from "fastify";
import type { AuthHandlers } from "../../controllers/auth.controller.js";
import { requireAuth } from "../../middleware/auth.js";

export async function authRoutes(app: FastifyInstance, handlers: AuthHandlers) {
  app.post("/auth/register", handlers.register);
  app.post("/auth/login", handlers.login);
  app.post("/auth/logout", handlers.logout);
  app.get("/me", { preHandler: requireAuth }, handlers.me);
}
