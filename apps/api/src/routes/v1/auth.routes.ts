import type { FastifyInstance } from "fastify";
import type { AuthHandlers } from "../../controllers/auth.controller.js";
import { requireAuth } from "../../middleware/auth.js";

export async function authRoutes(app: FastifyInstance, handlers: AuthHandlers) {
  app.get("/auth/providers", handlers.providers);
  app.get("/auth/invite/:token", handlers.invitePreview);
  app.get("/auth/oauth/:provider/start", handlers.oauthStart);
  app.get("/auth/oauth/:provider/callback", handlers.oauthCallback);
  app.post("/auth/register", handlers.register);
  app.post("/auth/accept-invite", handlers.acceptInvite);
  app.post("/auth/forgot-password", handlers.forgotPassword);
  app.post("/auth/reset-password", handlers.resetPassword);
  app.post("/auth/login", handlers.login);
  app.post("/auth/logout", handlers.logout);
  app.get("/me", { preHandler: requireAuth }, handlers.me);
}
