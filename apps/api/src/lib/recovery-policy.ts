import { createAppError } from "./errors.js";

const MIN_RECOVERY_LIFETIME_MINUTES = 10;
const MAX_RECOVERY_LIFETIME_MINUTES = 2_147_483_647;

export function assertRecoveryLifetimeWithinLimit(minutes: number | null | undefined): void {
  if (minutes == null) return;
  if (
    !Number.isInteger(minutes) ||
    minutes < MIN_RECOVERY_LIFETIME_MINUTES ||
    minutes > MAX_RECOVERY_LIFETIME_MINUTES
  ) {
    throw createAppError(
      400,
      `Recovery resource lifetime must be a whole number between ${MIN_RECOVERY_LIFETIME_MINUTES} and ${MAX_RECOVERY_LIFETIME_MINUTES} minutes`,
      "INVALID_RECOVERY_LIFETIME"
    );
  }
}
