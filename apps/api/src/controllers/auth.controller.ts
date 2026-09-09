import type { FastifyReply, FastifyRequest } from "fastify";
import { loginSchema, registerSchema } from "../validations/auth.schema.js";
import type { AuthService } from "../services/auth.service.js";
import { isAppError } from "../lib/errors.js";

export class AuthController {
  constructor(private authService: AuthService) {}

  register = async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = registerSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid request", code: "VALIDATION_ERROR" });
    }

    try {
      const { user } = await this.authService.register(parsed.data);
      return this.authService.issueSession(reply, user);
    } catch (err) {
      if (isAppError(err)) {
        return reply.status(err.statusCode).send({ error: err.message, code: err.code });
      }
      request.log.error(err);
      return reply.status(500).send({ error: "Registration failed", code: "INTERNAL" });
    }
  };

  login = async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid request", code: "VALIDATION_ERROR" });
    }

    try {
      const user = await this.authService.login(parsed.data);
      return this.authService.issueSession(reply, user);
    } catch (err) {
      if (isAppError(err)) {
        return reply.status(err.statusCode).send({ error: err.message, code: err.code });
      }
      request.log.error(err);
      return reply.status(500).send({ error: "Login failed", code: "INTERNAL" });
    }
  };

  logout = async (_request: FastifyRequest, reply: FastifyReply) => {
    return this.authService.logout(reply);
  };

  me = async (request: FastifyRequest) => {
    return { user: request.user };
  };
}
