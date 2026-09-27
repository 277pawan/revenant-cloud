/** Postgres error shape from node-pg */
export function isPgError(err: unknown): err is { code?: string; message?: string } {
  return typeof err === "object" && err != null && "code" in err;
}

export function isMissingRelationError(err: unknown): boolean {
  return isPgError(err) && err.code === "42P01";
}

export function migrationRequiredMessage(feature: string): string {
  const migration = feature.toLowerCase().includes("recovery point")
    ? "0023_recovery_points"
    : "0016_recovery_readiness";
  return `${feature} requires database migration ${migration}. Run: npm run db:migrate -w @revenant/api`;
}
