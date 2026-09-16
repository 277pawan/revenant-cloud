import { eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AuthUser, OAuthProviderId, OrganizationPlan } from "@revenant/shared";
import { isSubscriptionActive } from "../lib/org-subscription.js";
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

const OAUTH_IDS = new Set<string>(["google", "github", "microsoft"]);

function appRedirectUrl(env: Env, returnTo: string): string {
  if (returnTo.startsWith("http://") || returnTo.startsWith("https://")) {
    return returnTo;
  }
  const base = env.PUBLIC_APP_URL.replace(/\/$/, "");
  return `${base}${returnTo.startsWith("/") ? returnTo : `/${returnTo}`}`;
}

function oauthCompleteUrl(
  env: Env,
  message: string | null,
  opts?: { popup?: boolean; returnTo?: string }
): string {
  let base = env.PUBLIC_APP_URL.replace(/\/$/, "");
  if (opts?.returnTo?.startsWith("http://") || opts?.returnTo?.startsWith("https://")) {
    try {
      base = new URL(opts.returnTo).origin;
    } catch {
      /* keep app url */
    }
  }
  const url = new URL(`${base}/auth/oauth/complete`);
  if (message) url.searchParams.set("oauth_error", message);
  if (opts?.popup) url.searchParams.set("popup", "1");
  return url.toString();
}

function oauthCompleteErrorUrl(
  env: Env,
  message: string,
  popup?: boolean,
  returnTo?: string
): string {
  return oauthCompleteUrl(env, message, { popup, returnTo });
}

function oauthLoginErrorUrl(
  env: Env,
  message: string,
  popup?: boolean,
  returnTo?: string
): string {
  if (popup) {
    return oauthCompleteErrorUrl(env, message, true, returnTo);
  }
  let base = env.PUBLIC_APP_URL.replace(/\/$/, "");
  if (returnTo?.startsWith("http://") || returnTo?.startsWith("https://")) {
    try {
      base = new URL(returnTo).origin;
    } catch {
      /* keep */
    }
  }
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
        .select({
          plan: organizations.plan,
          subscriptionStatus: organizations.subscriptionStatus,
          trialEndsAt: organizations.trialEndsAt,
        })
        .from(organizations)
        .where(eq(organizations.id, request.user.organizationId))
        .limit(1);

      const billing = {
        plan: org?.plan ?? "starter",
        subscriptionStatus: org?.subscriptionStatus ?? "trialing",
        trialEndsAt: org?.trialEndsAt ?? null,
      };

      return {
        user: {
          ...request.user,
          organizationPlan: (org?.plan ?? "starter") as OrganizationPlan,
          subscriptionStatus: billing.subscriptionStatus as AuthUser["subscriptionStatus"],
          trialEndsAt: org?.trialEndsAt?.toISOString() ?? null,
          subscriptionActive: isSubscriptionActive(billing),
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
        const popup = (request.query as { popup?: string }).popup === "1";
        const state = signOAuthState(env.JWT_SECRET, {
          returnTo,
          issuedAt: Date.now(),
          nonce: randomBytes(8).toString("hex"),
          ...(inviteToken ? { inviteToken } : {}),
          ...(popup ? { popup: true } : {}),
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

      let statePayload: ReturnType<typeof verifyOAuthState> | undefined;
      if (q.state) {
        try {
          statePayload = verifyOAuthState(env.JWT_SECRET, q.state);
        } catch {
          statePayload = undefined;
        }
      }
      const popup = statePayload?.popup === true;

      if (q.error) {
        return reply.redirect(
          oauthLoginErrorUrl(env, "Sign-in was cancelled.", popup, statePayload?.returnTo)
        );
      }
      if (!q.code || !q.state || !statePayload) {
        return reply.redirect(
          oauthLoginErrorUrl(
            env,
            "Sign-in failed. Please try again.",
            popup,
            statePayload?.returnTo
          )
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
        const session = await authService.issueSession(reply, user);
        const target = new URL(appRedirectUrl(env, statePayload.returnTo));
        target.hash = `token=${encodeURIComponent(session.token)}`;
        if (popup) {
          target.searchParams.set("popup", "1");
        }
        return reply.redirect(target.toString());
      } catch (err) {
        request.log.error(err);
        return reply.redirect(
          oauthLoginErrorUrl(
            env,
            oauthUserMessage(err),
            popup,
            statePayload.returnTo
          )
        );
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
