import { createHash, createHmac } from "node:crypto";

/** Canonical HMAC signature for recovery passport payloads. */
export function signRecoveryPayload(payload: string, secret: string): string {
  const digest = createHmac("sha256", secret).update(payload).digest("hex");
  return `hmac-sha256:${digest}`;
}

export function hashRecoveryPayload(payload: string): string {
  return createHash("sha256").update(payload).digest("hex");
}
