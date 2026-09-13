import { eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { OAuthProviderId, OrganizationPlan } from "@revenant/shared";
import { loginSchema, registerSchema } from "../validations/auth.schema.js";
import type { AuthService } from "../services/auth.service.js";
import type { AuthProvidersService } from "../services/auth-providers.service.js";
import { organizations } from "../db/schema.js";
import { sendHandlerError } from "../lib/http.js";
import { createAppError } from "../lib/errors.js";
import { parseCorsOrigins } from "../lib/cors-origins.js";
import { sanitizeOAuthReturnTo, signOAuthState, verifyOAuthState } from "../lib/oauth-state.js";
import type { Env } from "../config/env.js";

const OAUTH_IDS = new Set<string>(["google", "github", "microsoft"]);

export function createAuthHandlers(
  authService: AuthService,
  authProvidersService: AuthProvidersService,
  env: Env
) {
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
      const [org] = await request.server.db
        .select({ plan: organizations.plan })
        .from(organizations)
        .where(eq(organizations.id, request.user.organizationId))
        .limit(1);

      return {
        user: {
          ...request.user,
          organizationPlan: (org?.plan ?? "starter") as OrganizationPlan,
        },
      };
    },

    providers: async () => {
      return authProvidersService.listProviders();
    },

    oauthStart: async (
      request: FastifyRequest<{ Params: { provider: string } }>,
      reply: FastifyReply
    ) => {
      const provider = request.params.provider;
      if (!OAUTH_IDS.has(provider)) {
        return reply.status(400).send({ error: "Unknown provider", code: "VALIDATION_ERROR" });
      }

      try {
        const allowed = parseCorsOrigins(env.CORS_ORIGIN);
        const returnTo = sanitizeOAuthReturnTo(
          (request.query as { returnTo?: string }).returnTo,
          allowed
        );
        const state = signOAuthState(env.JWT_SECRET, {
          returnTo,
          issuedAt: Date.now(),
          nonce: randomBytes(8).toString("hex"),
        });

        const url = authProvidersService.buildOAuthStartUrl(
          provider as OAuthProviderId,
          state
        );
        return reply.redirect(url);
      } catch (err) {
        return sendHandlerError(err, request, reply, "OAuth start failed");
      }
    },

    oauthCallback: async (
      request: FastifyRequest<{ Params: { provider: string } }>,
      reply: FastifyReply
    ) => {
      const provider = request.params.provider;
      if (!OAUTH_IDS.has(provider)) {
        return reply.status(400).send({ error: "Unknown provider", code: "VALIDATION_ERROR" });
      }

      try {
        const q = request.query as { state?: string; code?: string };
        if (q.state) {
          try {
            verifyOAuthState(env.JWT_SECRET, q.state);
          } catch {
            throw createAppError(400, "Invalid or expired OAuth state", "OAUTH_STATE");
          }
        }
        // Token exchange + user_auth_providers linking ships with marketing-site SSO.
        throw createAppError(
          501,
          `${provider} callback is wired on the server — complete token exchange when the website SSO goes live`,
          "OAUTH_CALLBACK_PENDING"
        );
      } catch (err) {
        return sendHandlerError(err, request, reply, "OAuth callback failed");
      }
    },

    invitePreview: async (
      request: FastifyRequest<{ Params: { token: string } }>,
      reply: FastifyReply
    ) => {
      try {
        const preview = await authProvidersService.previewInvite(request.params.token);
        return { invite: preview };
      } catch (err) {
        return sendHandlerError(err, request, reply, "Invite preview failed");
      }
    },
  };
}

export type AuthHandlers = ReturnType<typeof createAuthHandlers>;
