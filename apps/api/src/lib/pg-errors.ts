/** Postgres error shape from node-pg */
export function isPgError(err: unknown): err is { code?: string; message?: string } {
  return typeof err === "object" && err != null && "code" in err;
}

export function isMissingRelationError(err: unknown): boolean {
  return isPgError(err) && err.code === "42P01";
}

export function isMissingDatabaseObjectError(err: unknown): boolean {
  return isPgError(err) && (err.code === "42P01" || err.code === "42703");
}

export function migrationRequiredMessage(feature: string, err?: unknown): string {
  const normalizedFeature = feature.toLowerCase();
  const errorMessage =
    typeof err === "object" && err !== null && "message" in err
      ? String(err.message).toLowerCase()
      : "";
  const migration = normalizedFeature.includes("redis")
    ? errorMessage.includes("checks_json")
      ? "0030_redis_proof_checks"
      : errorMessage.includes("compression")
        ? "0028_redis_artifact_compression"
        : "0026_redis_resources"
    : normalizedFeature.includes("recovery point")
      ? "0023_recovery_points"
      : "0016_recovery_readiness";
  return `${feature} requires database migration ${migration}. Run: npm run db:migrate -w @revenant/api`;
}
