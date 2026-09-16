import { createHmac, timingSafeEqual } from "node:crypto";

export interface OAuthStatePayload {
  returnTo: string;
  issuedAt: number;
  nonce: string;
  inviteToken?: string;
  /** OAuth opened in a browser popup from the SPA */
  popup?: boolean;
}

function signPart(secret: string, b64: string): string {
  return createHmac("sha256", secret).update(b64).digest("base64url");
}

export function signOAuthState(secret: string, payload: OAuthStatePayload): string {
  const b64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${b64}.${signPart(secret, b64)}`;
}

export function verifyOAuthState(
  secret: string,
  state: string,
  maxAgeMs = 10 * 60 * 1000
): OAuthStatePayload {
  const parts = state.split(".");
  if (parts.length !== 2) {
    throw new Error("Invalid OAuth state");
  }
  const [b64, sig] = parts;
  const expected = signPart(secret, b64);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error("Invalid OAuth state signature");
  }

  const payload = JSON.parse(Buffer.from(b64, "base64url").toString("utf8")) as OAuthStatePayload;
  if (
    typeof payload.returnTo !== "string" ||
    typeof payload.issuedAt !== "number" ||
    typeof payload.nonce !== "string" ||
    (payload.inviteToken !== undefined && typeof payload.inviteToken !== "string") ||
    (payload.popup !== undefined && typeof payload.popup !== "boolean")
  ) {
    throw new Error("Invalid OAuth state payload");
  }
  if (Date.now() - payload.issuedAt > maxAgeMs) {
    throw new Error("OAuth state expired");
  }
  return payload;
}

/**
 * Relative app paths, or absolute URLs whose origin is on the CORS allowlist.
 */
export function sanitizeOAuthReturnTo(
  returnTo: string | undefined,
  allowedOrigins: string[],
  fallback = "/"
): string {
  const raw = (returnTo ?? fallback).trim() || fallback;
  if (raw.startsWith("/") && !raw.startsWith("//")) {
    return raw;
  }
  try {
    const url = new URL(raw);
    if (allowedOrigins.includes(url.origin)) {
      return url.toString();
    }
  } catch {
    /* fall through */
  }
  return fallback;
}
