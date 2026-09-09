import type { FastifyInstance } from "fastify";
import type { AuthController } from "../../controllers/auth.controller.js";
import { requireAuth } from "../../middleware/auth.js";

export async function authRoutes(app: FastifyInstance, controller: AuthController) {
  app.post("/auth/register", controller.register);
  app.post("/auth/login", controller.login);
  app.post("/auth/logout", controller.logout);
  app.get("/me", { preHandler: requireAuth }, controller.me);
}
