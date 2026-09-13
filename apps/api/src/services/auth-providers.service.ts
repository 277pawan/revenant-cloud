import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import type {
  AuthProviderInfo,
  AuthProvidersResponse,
  InvitePreviewResponse,
  OAuthProviderId,
} from "@revenant/shared";
import type { Database } from "../db/index.js";
import { organizationInvites, organizations } from "../db/schema.js";
import { createAppError } from "../lib/errors.js";
import type { Env } from "../config/env.js";

const PROVIDER_META: Record<
  OAuthProviderId,
  { label: string; authorizeUrl: (p: { clientId: string; redirectUri: string; state: string }) => string }
> = {
  google: {
    label: "Google",
    authorizeUrl: ({ clientId, redirectUri, state }) =>
      `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: "openid email profile",
        state,
        access_type: "offline",
        prompt: "select_account",
      }).toString()}`,
  },
  github: {
    label: "GitHub",
    authorizeUrl: ({ clientId, redirectUri, state }) =>
      `https://github.com/login/oauth/authorize?${new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: "read:user user:email",
        state,
      }).toString()}`,
  },
  microsoft: {
    label: "Microsoft",
    authorizeUrl: ({ clientId, redirectUri, state }) =>
      `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: "openid email profile",
        state,
      }).toString()}`,
  },
};

function isProviderConfigured(env: Env, id: OAuthProviderId): boolean {
  switch (id) {
    case "google":
      return !!(env.OAUTH_GOOGLE_CLIENT_ID && env.OAUTH_GOOGLE_CLIENT_SECRET);
    case "github":
      return !!(env.OAUTH_GITHUB_CLIENT_ID && env.OAUTH_GITHUB_CLIENT_SECRET);
    case "microsoft":
      return !!(env.OAUTH_MICROSOFT_CLIENT_ID && env.OAUTH_MICROSOFT_CLIENT_SECRET);
    default:
      return false;
  }
}

function clientIdFor(env: Env, id: OAuthProviderId): string | undefined {
  switch (id) {
    case "google":
      return env.OAUTH_GOOGLE_CLIENT_ID;
    case "github":
      return env.OAUTH_GITHUB_CLIENT_ID;
    case "microsoft":
      return env.OAUTH_MICROSOFT_CLIENT_ID;
    default:
      return undefined;
  }
}

export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generateInviteToken(): string {
  return randomBytes(32).toString("base64url");
}

export function createAuthProvidersService(db: Database, env: Env) {
  return {
    listProviders(): AuthProvidersResponse {
      const ids: OAuthProviderId[] = ["google", "github", "microsoft"];

      const providers: AuthProviderInfo[] = ids.map((id) => {
        const configured = isProviderConfigured(env, id);
        return {
          id,
          label: PROVIDER_META[id].label,
          status: configured ? "live" : "coming_soon",
          authorizePath: configured
            ? `/api/v1/auth/oauth/${id}/start`
            : undefined,
        };
      });

      return {
        providers,
        passwordLoginEnabled: true,
        openRegistration: env.ALLOW_OPEN_REGISTRATION,
      };
    },

    buildOAuthStartUrl(provider: OAuthProviderId, state: string): string {
      if (!isProviderConfigured(env, provider)) {
        throw createAppError(
          501,
          `${PROVIDER_META[provider].label} sign-in is not configured yet`,
          "OAUTH_NOT_CONFIGURED"
        );
      }

      const clientId = clientIdFor(env, provider);
      if (!clientId) {
        throw createAppError(501, "OAuth client not configured", "OAUTH_NOT_CONFIGURED");
      }

      const redirectUri = `${env.OAUTH_REDIRECT_BASE_URL}/api/v1/auth/oauth/${provider}/callback`;
      return PROVIDER_META[provider].authorizeUrl({
        clientId,
        redirectUri,
        state,
      });
    },

    async previewInvite(token: string): Promise<InvitePreviewResponse> {
      const tokenHash = hashInviteToken(token);
      const now = new Date();

      const rows = await db
        .select({
          email: organizationInvites.email,
          role: organizationInvites.role,
          expiresAt: organizationInvites.expiresAt,
          orgName: organizations.name,
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

      return {
        organizationName: row.orgName,
        role: row.role,
        email: row.email,
        expiresAt: row.expiresAt.toISOString(),
      };
    },
  };
}

export type AuthProvidersService = ReturnType<typeof createAuthProvidersService>;
