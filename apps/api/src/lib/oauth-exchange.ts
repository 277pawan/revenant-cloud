import type { OAuthProviderId } from "@revenant/shared";
import type { Env } from "../config/env.js";
import { createAppError } from "./errors.js";

export interface OAuthUserProfile {
  provider: OAuthProviderId;
  subject: string;
  email: string;
  name?: string;
}

function redirectUri(env: Env, provider: OAuthProviderId): string {
  return `${env.OAUTH_REDIRECT_BASE_URL.replace(/\/$/, "")}/api/v1/auth/oauth/${provider}/callback`;
}

function oauthUpstreamError(provider: string, detail: string): void {
  console.error(`[oauth] ${provider} upstream error`, detail.slice(0, 500));
}

export async function exchangeOAuthCode(
  env: Env,
  provider: OAuthProviderId,
  code: string
): Promise<OAuthUserProfile> {
  switch (provider) {
    case "google":
      return exchangeGoogle(env, code);
    case "github":
      return exchangeGitHub(env, code);
    case "microsoft":
      return exchangeMicrosoft(env, code);
    default:
      throw createAppError(400, "Unknown provider", "VALIDATION_ERROR");
  }
}

async function exchangeGoogle(env: Env, code: string): Promise<OAuthUserProfile> {
  const clientId = env.OAUTH_GOOGLE_CLIENT_ID;
  const clientSecret = env.OAUTH_GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw createAppError(501, "Google sign-in is not configured", "OAUTH_NOT_CONFIGURED");
  }

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri(env, "google"),
      grant_type: "authorization_code",
    }),
  });

  if (!tokenRes.ok) {
    oauthUpstreamError("google", await tokenRes.text());
    throw createAppError(502, "Sign-in failed. Please try again.", "OAUTH_UPSTREAM");
  }

  const tokenPayload = (await tokenRes.json()) as { access_token?: string };
  if (!tokenPayload.access_token) {
    oauthUpstreamError("google", "missing access_token");
    throw createAppError(502, "Sign-in failed. Please try again.", "OAUTH_UPSTREAM");
  }

  const userRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${tokenPayload.access_token}` },
  });

  if (!userRes.ok) {
    oauthUpstreamError("google", await userRes.text());
    throw createAppError(502, "Sign-in failed. Please try again.", "OAUTH_UPSTREAM");
  }

  const user = (await userRes.json()) as {
    sub?: string;
    email?: string;
    email_verified?: boolean;
    name?: string;
  };

  if (!user.sub || !user.email) {
    throw createAppError(502, "Sign-in failed. Please try again.", "OAUTH_UPSTREAM");
  }
  if (user.email_verified === false) {
    throw createAppError(
      403,
      "Use a verified Google email to sign in.",
      "OAUTH_EMAIL_UNVERIFIED"
    );
  }

  return {
    provider: "google",
    subject: user.sub,
    email: user.email.toLowerCase(),
    name: user.name,
  };
}

async function exchangeGitHub(env: Env, code: string): Promise<OAuthUserProfile> {
  const clientId = env.OAUTH_GITHUB_CLIENT_ID;
  const clientSecret = env.OAUTH_GITHUB_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw createAppError(501, "GitHub sign-in is not configured", "OAUTH_NOT_CONFIGURED");
  }

  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri(env, "github"),
    }),
  });

  if (!tokenRes.ok) {
    oauthUpstreamError("github", await tokenRes.text());
    throw createAppError(502, "Sign-in failed. Please try again.", "OAUTH_UPSTREAM");
  }

  const tokenPayload = (await tokenRes.json()) as {
    access_token?: string;
    error?: string;
  };
  if (!tokenPayload.access_token) {
    oauthUpstreamError("github", tokenPayload.error ?? "missing access_token");
    throw createAppError(502, "Sign-in failed. Please try again.", "OAUTH_UPSTREAM");
  }

  const headers = {
    Authorization: `Bearer ${tokenPayload.access_token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "Revenant-Cloud",
  };

  const userRes = await fetch("https://api.github.com/user", { headers });
  if (!userRes.ok) {
    oauthUpstreamError("github", await userRes.text());
    throw createAppError(502, "Sign-in failed. Please try again.", "OAUTH_UPSTREAM");
  }

  const user = (await userRes.json()) as {
    id?: number;
    login?: string;
    name?: string;
    email?: string | null;
  };

  if (!user.id) {
    throw createAppError(502, "Sign-in failed. Please try again.", "OAUTH_UPSTREAM");
  }

  let email = user.email?.toLowerCase() ?? "";
  if (!email) {
    const emailsRes = await fetch("https://api.github.com/user/emails", { headers });
    if (!emailsRes.ok) {
      oauthUpstreamError("github", await emailsRes.text());
      throw createAppError(502, "Sign-in failed. Please try again.", "OAUTH_UPSTREAM");
    }
    const emails = (await emailsRes.json()) as Array<{
      email: string;
      primary: boolean;
      verified: boolean;
    }>;
    const primary = emails.find((e) => e.primary && e.verified);
    const verified = emails.find((e) => e.verified);
    email = (primary ?? verified)?.email?.toLowerCase() ?? "";
  }

  if (!email) {
    throw createAppError(
      403,
      "GitHub did not share a verified email. Make one public or use Google sign-in.",
      "OAUTH_EMAIL_MISSING"
    );
  }

  return {
    provider: "github",
    subject: String(user.id),
    email,
    name: user.name ?? user.login,
  };
}

async function exchangeMicrosoft(env: Env, code: string): Promise<OAuthUserProfile> {
  const clientId = env.OAUTH_MICROSOFT_CLIENT_ID;
  const clientSecret = env.OAUTH_MICROSOFT_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw createAppError(501, "Microsoft sign-in is not configured", "OAUTH_NOT_CONFIGURED");
  }

  const tokenRes = await fetch(
    "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri(env, "microsoft"),
        grant_type: "authorization_code",
        scope: "openid profile email User.Read",
      }),
    }
  );

  if (!tokenRes.ok) {
    oauthUpstreamError("microsoft", await tokenRes.text());
    throw createAppError(502, "Sign-in failed. Please try again.", "OAUTH_UPSTREAM");
  }

  const tokenPayload = (await tokenRes.json()) as { access_token?: string };
  if (!tokenPayload.access_token) {
    oauthUpstreamError("microsoft", "missing access_token");
    throw createAppError(502, "Sign-in failed. Please try again.", "OAUTH_UPSTREAM");
  }

  const userRes = await fetch("https://graph.microsoft.com/v1.0/me", {
    headers: { Authorization: `Bearer ${tokenPayload.access_token}` },
  });

  if (!userRes.ok) {
    oauthUpstreamError("microsoft", await userRes.text());
    throw createAppError(502, "Sign-in failed. Please try again.", "OAUTH_UPSTREAM");
  }

  const user = (await userRes.json()) as {
    id?: string;
    displayName?: string;
    mail?: string | null;
    userPrincipalName?: string | null;
  };

  const email = (user.mail || user.userPrincipalName || "").toLowerCase();
  if (!user.id || !email) {
    throw createAppError(
      403,
      "Microsoft did not share an email. Use another account or Google sign-in.",
      "OAUTH_EMAIL_MISSING"
    );
  }

  return {
    provider: "microsoft",
    subject: user.id,
    email,
    name: user.displayName,
  };
}
