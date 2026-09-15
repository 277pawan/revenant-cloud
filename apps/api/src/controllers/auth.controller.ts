import { eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { OAuthProviderId, OrganizationPlan } from "@revenant/shared";
import {
  acceptInviteSchema,
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
} from "../validations/auth.schema.js";
import type { AuthService } from "../services/auth.service.js";
import type { AuthProvidersService } from "../services/auth-providers.service.js";
import { organizations } from "../db/schema.js";
import { sendHandlerError } from "../lib/http.js";
import { createAppError } from "../lib/errors.js";
import { parseCorsOrigins } from "../lib/cors-origins.js";
import { exchangeOAuthCode } from "../lib/oauth-exchange.js";
import { isAppError } from "../lib/errors.js";
import { sanitizeOAuthReturnTo, signOAuthState, verifyOAuthState } from "../lib/oauth-state.js";
import type { Env } from "../config/env.js";

const OAUTH_IDS = new Set<string>(["google", "github"]);

function appRedirectUrl(env: Env, returnTo: string): string {
  if (returnTo.startsWith("http://") || returnTo.startsWith("https://")) {
    return returnTo;
  }
  const base = env.PUBLIC_APP_URL.replace(/\/$/, "");
  return `${base}${returnTo.startsWith("/") ? returnTo : `/${returnTo}`}`;
}

function oauthLoginErrorUrl(env: Env, message: string): string {
  const base = env.PUBLIC_APP_URL.replace(/\/$/, "");
  return `${base}/login?oauth_error=${encodeURIComponent(message)}`;
}

function oauthUserMessage(err: unknown): string {
  if (isAppError(err)) {
    switch (err.code) {
      case "REGISTRATION_DISABLED":
      case "INVITE_EMAIL_MISMATCH":
      case "INVITE_NOT_FOUND":
      case "OAUTH_EMAIL_UNVERIFIED":
      case "OAUTH_EMAIL_MISSING":
      case "CONFLICT":
        return err.message;
      default:
        return "Sign-in failed. Please try again.";
    }
  }
  return "Sign-in failed. Please try again.";
}

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

    acceptInvite: async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = acceptInviteSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ error: "Invalid request", code: "VALIDATION_ERROR" });
      }

      try {
        const { user } = await authService.acceptInvite(parsed.data);
        return authService.issueSession(reply, user);
      } catch (err) {
        return sendHandlerError(err, request, reply, "Could not accept invite");
      }
    },

    forgotPassword: async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = forgotPasswordSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ error: "Invalid request", code: "VALIDATION_ERROR" });
      }

      try {
        return await authService.requestPasswordReset(parsed.data);
      } catch (err) {
        return sendHandlerError(err, request, reply, "Could not send reset email");
      }
    },

    resetPassword: async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = resetPasswordSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ error: "Invalid request", code: "VALIDATION_ERROR" });
      }

      try {
        return await authService.resetPassword(parsed.data);
      } catch (err) {
        return sendHandlerError(err, request, reply, "Could not reset password");
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
        const inviteToken = (request.query as { invite?: string }).invite?.trim();
        const state = signOAuthState(env.JWT_SECRET, {
          returnTo,
          issuedAt: Date.now(),
          nonce: randomBytes(8).toString("hex"),
          ...(inviteToken ? { inviteToken } : {}),
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

      const q = request.query as { state?: string; code?: string; error?: string };

      if (q.error) {
        return reply.redirect(oauthLoginErrorUrl(env, "Sign-in was cancelled."));
      }
      if (!q.code || !q.state) {
        return reply.redirect(
          oauthLoginErrorUrl(env, "Sign-in failed. Please try again.")
        );
      }

      let statePayload;
      try {
        statePayload = verifyOAuthState(env.JWT_SECRET, q.state);
      } catch {
        return reply.redirect(
          oauthLoginErrorUrl(env, "Sign-in session expired. Please try again.")
        );
      }

      try {
        const profile = await exchangeOAuthCode(
          env,
          provider as OAuthProviderId,
          q.code
        );
        const user = await authService.loginWithOAuth(
          profile,
          statePayload.inviteToken
        );
        await authService.issueSession(reply, user);
        return reply.redirect(appRedirectUrl(env, statePayload.returnTo));
      } catch (err) {
        request.log.error(err);
        return reply.redirect(oauthLoginErrorUrl(env, oauthUserMessage(err)));
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
