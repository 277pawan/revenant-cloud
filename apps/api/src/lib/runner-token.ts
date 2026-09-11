import { createHash, randomBytes } from "node:crypto";

export function hashRunnerToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Opaque token: rvn_ + 32 random bytes hex */
export function generateRunnerToken(): { token: string; prefix: string; hash: string } {
  const token = `rvn_${randomBytes(32).toString("hex")}`;
  return {
    token,
    prefix: token.slice(0, 12),
    hash: hashRunnerToken(token),
  };
}
