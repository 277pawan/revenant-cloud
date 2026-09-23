/** Postgres error shape from node-pg */
export function isPgError(err: unknown): err is { code?: string; message?: string } {
  return typeof err === "object" && err != null && "code" in err;
}

export function isMissingRelationError(err: unknown): boolean {
  return isPgError(err) && err.code === "42P01";
}

export function migrationRequiredMessage(feature: string): string {
  return `${feature} requires database migration 0016_recovery_readiness. Run: npm run db:migrate -w @revenant/api`;
}
