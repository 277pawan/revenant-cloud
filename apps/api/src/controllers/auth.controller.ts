import type { FastifyReply, FastifyRequest } from "fastify";
import { loginSchema, registerSchema } from "../validations/auth.schema.js";
import type { AuthService } from "../services/auth.service.js";
import { sendHandlerError } from "../lib/http.js";

export function createAuthHandlers(authService: AuthService) {
  return {
    register: async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = registerSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ error: "Invalid request", code: "VALIDATION_ERROR" });
      }

      try {
        const { user } = await authService.register(parsed.data);
        return authService.issueSession(reply, user);
      } catch (err) {
        return sendHandlerError(err, request, reply, "Registration failed");
      }
    },

    login: async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = loginSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ error: "Invalid request", code: "VALIDATION_ERROR" });
      }

      try {
        const user = await authService.login(parsed.data);
        return authService.issueSession(reply, user);
      } catch (err) {
        return sendHandlerError(err, request, reply, "Login failed");
      }
    },

    logout: async (_request: FastifyRequest, reply: FastifyReply) => {
      return authService.logout(reply);
    },

    me: async (request: FastifyRequest) => {
      return { user: request.user };
    },
  };
}

export type AuthHandlers = ReturnType<typeof createAuthHandlers>;
