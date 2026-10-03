import { createAppError } from "./errors.js";

const DEFAULT_MAX_LIFETIME_MINUTES = 60;

export function configuredRecoveryMaxLifetimeMinutes(): number {
  const raw = process.env.AWS_RECOVERY_MAX_LIFETIME_MINUTES?.trim();
  const value = raw ? Number(raw) : DEFAULT_MAX_LIFETIME_MINUTES;
  if (!Number.isInteger(value) || value < 10 || value > 1440) {
    throw new Error(
      "AWS_RECOVERY_MAX_LIFETIME_MINUTES must be an integer between 10 and 1440"
    );
  }
  return value;
}

export function assertRecoveryLifetimeWithinLimit(minutes: number | null | undefined): void {
  if (minutes == null) return;
  const maximum = configuredRecoveryMaxLifetimeMinutes();
  if (minutes > maximum) {
    throw createAppError(
      400,
      `Recovery resource lifetime cannot exceed the configured maximum of ${maximum} minutes`,
      "RECOVERY_LIFETIME_EXCEEDS_LIMIT"
    );
  }
}
