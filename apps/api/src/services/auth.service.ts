import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { FastifyReply } from "fastify";
import type {
  AuthUser,
  OrganizationPlan,
  SubscriptionStatus,
  UserRole,
} from "@revenant/shared";
import {
  isSubscriptionActive,
  trialEndsAtFromNow,
} from "../lib/org-subscription.js";
import type { Database } from "../db/index.js";
import {
  organizationInvites,
  organizations,
  passwordResetTokens,
  userAuthProviders,
  users,
} from "../db/schema.js";
import type { OAuthUserProfile } from "../lib/oauth-exchange.js";
import { hashPassword, verifyPassword } from "../lib/password.js";
import { clearSessionCookie, setSessionCookie } from "../lib/session.js";
import { createAppError } from "../lib/errors.js";
import {
  passwordResetHtml,
  passwordResetPlainText,
} from "../lib/notification-templates.js";
import {
  isTransactionalMailConfigured,
  sendTransactionalMail,
} from "../lib/transactional-mail.js";
import { hashInviteToken } from "./auth-providers.service.js";
import type { Env } from "../config/env.js";
import type {
  AcceptInviteInput,
  ForgotPasswordInput,
  LoginInput,
  RegisterInput,
  ResetPasswordInput,
} from "../validations/auth.schema.js";

function hashResetToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function defaultOrgName(email: string, name?: string): string {
  if (name?.trim()) {
    return `${name.trim()}'s organization`;
  }
  const domain = email.split("@")[1]?.split(".")[0] ?? "team";
  return `${domain.charAt(0).toUpperCase()}${domain.slice(1)}`;
}

type OrgRow = {
  id: string;
  name: string;
  plan: string | null;
  subscriptionStatus?: string | null;
  trialEndsAt?: Date | null;
};

function toAuthUser(
  user: { id: string; email: string; role: string },
  org: OrgRow
): AuthUser {
  const billing = {
    plan: org.plan ?? "starter",
    subscriptionStatus: org.subscriptionStatus ?? "trialing",
    trialEndsAt: org.trialEndsAt ?? null,
  };
  return {
    id: user.id,
    email: user.email,
    role: user.role as UserRole,
    organizationId: org.id,
    organizationName: org.name,
    organizationPlan: (org.plan ?? "starter") as OrganizationPlan,
    subscriptionStatus: billing.subscriptionStatus as SubscriptionStatus,
    trialEndsAt: org.trialEndsAt?.toISOString() ?? null,
    subscriptionActive: isSubscriptionActive(billing),
  };
}

export function createAuthService(db: Database, env: Env) {
  return {
    async register(
      input: RegisterInput
    ): Promise<{ token: string; user: AuthUser }> {
      if (!env.ALLOW_OPEN_REGISTRATION) {
        throw createAppError(
          403,
          "Registration is disabled. Ask an admin for an invite.",
          "REGISTRATION_DISABLED"
        );
      }

      const passwordHash = await hashPassword(input.password);

      try {
        const [org] = await db
          .insert(organizations)
          .values({
            name: input.organizationName,
            plan: "starter",
            subscriptionStatus: "trialing",
            trialEndsAt: trialEndsAtFromNow(),
          })
          .returning();

        const [user] = await db
          .insert(users)
          .values({
            organizationId: org.id,
            email: input.email.toLowerCase(),
            passwordHash,
            role: "admin",
          })
          .returning();

        return { token: "", user: toAuthUser(user, org) };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "";
        if (message.includes("unique") || message.includes("duplicate")) {
          throw createAppError(409, "Email already registered", "CONFLICT");
        }
        throw err;
      }
    },

    async acceptInvite(
      input: AcceptInviteInput
    ): Promise<{ token: string; user: AuthUser }> {
      const tokenHash = hashInviteToken(input.inviteToken);
      const now = new Date();

      const rows = await db
        .select({
          invite: organizationInvites,
          org: organizations,
        })
        .from(organizationInvites)
        .innerJoin(
          organizations,
          eq(organizationInvites.organizationId, organizations.id)
        )
        .where(
          and(
            eq(organizationInvites.tokenHash, tokenHash),
            gt(organizationInvites.expiresAt, now),
            isNull(organizationInvites.acceptedAt)
          )
        )
        .limit(1);

      const row = rows[0];
      if (!row) {
        throw createAppError(404, "Invite link is invalid or expired", "INVITE_NOT_FOUND");
      }

      if (row.invite.email.toLowerCase() !== input.email.toLowerCase()) {
        throw createAppError(
          400,
          "Email does not match the invite",
          "INVITE_EMAIL_MISMATCH"
        );
      }

      const passwordHash = await hashPassword(input.password);

      try {
        const [user] = await db
          .insert(users)
          .values({
            organizationId: row.org.id,
            email: input.email.toLowerCase(),
            passwordHash,
            role: row.invite.role,
          })
          .returning();

        await db
          .update(organizationInvites)
          .set({ acceptedAt: now })
          .where(eq(organizationInvites.id, row.invite.id));

        return { token: "", user: toAuthUser(user, row.org) };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "";
        if (message.includes("unique") || message.includes("duplicate")) {
          throw createAppError(
            409,
            "An account with this email already exists in the organization",
            "CONFLICT"
          );
        }
        throw err;
      }
    },

    async requestPasswordReset(input: ForgotPasswordInput): Promise<{ ok: true }> {
      const email = input.email.toLowerCase();
      const rows = await db
        .select({ user: users })
        .from(users)
        .where(eq(users.email, email))
        .limit(1);

      const row = rows[0];
      if (!row?.user.passwordHash) {
        return { ok: true };
      }

      const token = randomBytes(32).toString("base64url");
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

      await db.insert(passwordResetTokens).values({
        userId: row.user.id,
        tokenHash: hashResetToken(token),
        expiresAt,
      });

      const resetUrl = `${env.PUBLIC_APP_URL}/reset-password?token=${encodeURIComponent(token)}`;

      if (!isTransactionalMailConfigured(env)) {
        if (env.NODE_ENV === "development") {
          console.log(`[dev] Password reset link for ${email}: ${resetUrl}`);
        } else {
          console.warn(
            "[mail] SMTP not configured — password reset email was not sent. Set SMTP_* in .env"
          );
        }
      } else {
        await sendTransactionalMail(env, {
          to: email,
          subject: "Reset your Revenant Cloud password",
          text: passwordResetPlainText(resetUrl),
          html: passwordResetHtml(resetUrl),
        });
      }

      return { ok: true };
    },

    async resetPassword(input: ResetPasswordInput): Promise<{ ok: true }> {
      const tokenHash = hashResetToken(input.token);
      const now = new Date();

      const rows = await db
        .select({ token: passwordResetTokens })
        .from(passwordResetTokens)
        .where(
          and(
            eq(passwordResetTokens.tokenHash, tokenHash),
            gt(passwordResetTokens.expiresAt, now),
            isNull(passwordResetTokens.usedAt)
          )
        )
        .limit(1);

      const row = rows[0];
      if (!row) {
        throw createAppError(400, "Reset link is invalid or expired", "RESET_TOKEN_INVALID");
      }

      const passwordHash = await hashPassword(input.password);

      await db
        .update(users)
        .set({ passwordHash, updatedAt: now })
        .where(eq(users.id, row.token.userId));

      await db
        .update(passwordResetTokens)
        .set({ usedAt: now })
        .where(eq(passwordResetTokens.id, row.token.id));

      return { ok: true };
    },

    async linkAuthProvider(userId: string, profile: OAuthUserProfile): Promise<void> {
      try {
        await db.insert(userAuthProviders).values({
          userId,
          provider: profile.provider,
          providerSubject: profile.subject,
          email: profile.email.toLowerCase(),
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "";
        if (!message.includes("unique") && !message.includes("duplicate")) {
          throw err;
        }
      }
    },

    async findUserByOAuth(
      profile: OAuthUserProfile
    ): Promise<AuthUser | null> {
      const byProvider = await db
        .select({ user: users, org: organizations })
        .from(userAuthProviders)
        .innerJoin(users, eq(userAuthProviders.userId, users.id))
        .innerJoin(organizations, eq(users.organizationId, organizations.id))
        .where(
          and(
            eq(userAuthProviders.provider, profile.provider),
            eq(userAuthProviders.providerSubject, profile.subject)
          )
        )
        .limit(1);

      const linked = byProvider[0];
      if (linked) {
        return toAuthUser(linked.user, linked.org);
      }
      return null;
    },

    async loginWithOAuth(
      profile: OAuthUserProfile,
      inviteToken?: string
    ): Promise<AuthUser> {
      const existingOAuth = await this.findUserByOAuth(profile);
      if (existingOAuth) {
        return existingOAuth;
      }

      const email = profile.email.toLowerCase();

      if (inviteToken) {
        const tokenHash = hashInviteToken(inviteToken);
        const now = new Date();

        const rows = await db
          .select({ invite: organizationInvites, org: organizations })
          .from(organizationInvites)
          .innerJoin(
            organizations,
            eq(organizationInvites.organizationId, organizations.id)
          )
          .where(
            and(
              eq(organizationInvites.tokenHash, tokenHash),
              gt(organizationInvites.expiresAt, now),
              isNull(organizationInvites.acceptedAt)
            )
          )
          .limit(1);

        const row = rows[0];
        if (!row) {
          throw createAppError(
            404,
            "Invite link is invalid or expired",
            "INVITE_NOT_FOUND"
          );
        }
        if (row.invite.email.toLowerCase() !== email) {
          throw createAppError(
            400,
            "This email doesn't match your invite",
            "INVITE_EMAIL_MISMATCH"
          );
        }

        try {
          const [user] = await db
            .insert(users)
            .values({
              organizationId: row.org.id,
              email,
              passwordHash: null,
              role: row.invite.role,
            })
            .returning();

          await db
            .update(organizationInvites)
            .set({ acceptedAt: now })
            .where(eq(organizationInvites.id, row.invite.id));

          await this.linkAuthProvider(user.id, profile);
          return toAuthUser(user, row.org);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : "";
          if (message.includes("unique") || message.includes("duplicate")) {
            throw createAppError(
              409,
              "An account with this email already exists",
              "CONFLICT"
            );
          }
          throw err;
        }
      }

      const byEmail = await db
        .select({ user: users, org: organizations })
        .from(users)
        .innerJoin(organizations, eq(users.organizationId, organizations.id))
        .where(eq(users.email, email))
        .limit(1);

      const emailRow = byEmail[0];
      if (emailRow) {
        await this.linkAuthProvider(emailRow.user.id, profile);
        return toAuthUser(emailRow.user, emailRow.org);
      }

      if (!env.ALLOW_OPEN_REGISTRATION) {
        throw createAppError(
          403,
          "No account found for this email. Ask your admin for an invite.",
          "REGISTRATION_DISABLED"
        );
      }

      try {
        const [org] = await db
          .insert(organizations)
          .values({
            name: defaultOrgName(email, profile.name),
            plan: "starter",
            subscriptionStatus: "trialing",
            trialEndsAt: trialEndsAtFromNow(),
          })
          .returning();

        const [user] = await db
          .insert(users)
          .values({
            organizationId: org.id,
            email,
            passwordHash: null,
            role: "admin",
          })
          .returning();

        await this.linkAuthProvider(user.id, profile);
        return toAuthUser(user, org);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "";
        if (message.includes("unique") || message.includes("duplicate")) {
          throw createAppError(409, "Email already registered", "CONFLICT");
        }
        throw err;
      }
    },

    async login(input: LoginInput): Promise<AuthUser> {
      const rows = await db
        .select({
          user: users,
          org: organizations,
        })
        .from(users)
        .innerJoin(organizations, eq(users.organizationId, organizations.id))
        .where(eq(users.email, input.email.toLowerCase()))
        .limit(1);

      const row = rows[0];
      if (!row) {
        throw createAppError(401, "Invalid email or password", "INVALID_CREDENTIALS");
      }

      if (!row.user.passwordHash) {
        throw createAppError(
          401,
          "This account uses single sign-on. Continue with Google or GitHub.",
          "OAUTH_REQUIRED"
        );
      }

      const valid = await verifyPassword(input.password, row.user.passwordHash);
      if (!valid) {
        throw createAppError(401, "Invalid email or password", "INVALID_CREDENTIALS");
      }

      return toAuthUser(row.user, row.org);
    },

    async issueSession(
      reply: FastifyReply,
      payload: AuthUser
    ): Promise<{ token: string; user: AuthUser }> {
      const token = await reply.jwtSign(payload, { expiresIn: env.JWT_EXPIRES_IN });
      setSessionCookie(reply, token, env);
      return { token, user: payload };
    },

    logout(reply: FastifyReply): { ok: boolean } {
      clearSessionCookie(reply, env);
      return { ok: true };
    },
  };
}

export type AuthService = ReturnType<typeof createAuthService>;
