/** Recovery Contract — what "recoverable" means for a system. */

export type RecoveryProviderId =
  | "postgres"
  | "aws-rds"
  | "mysql"
  | "redis"
  | "http"
  | "s3"
  | "kubernetes";

export type RecoveryProviderStatus = "available" | "planned" | "beta";

export interface RecoveryProviderDefinition {
  id: RecoveryProviderId;
  label: string;
  /** restore | dependency | application */
  role: "restore" | "dependency" | "application";
  status: RecoveryProviderStatus;
  /** Check types this provider can emit */
  checkTypes: string[];
}

/** Registry — extend one provider at a time without rewriting the contract model. */
export const RECOVERY_PROVIDERS: readonly RecoveryProviderDefinition[] = [
  {
    id: "postgres",
    label: "PostgreSQL",
    role: "restore",
    status: "available",
    checkTypes: ["schema", "row_count", "sql", "freshness", "index"],
  },
  {
    id: "aws-rds",
    label: "AWS RDS",
    role: "restore",
    status: "available",
    checkTypes: ["restore", "schema", "row_count", "sql"],
  },
  {
    id: "http",
    label: "HTTP / API",
    role: "application",
    status: "available",
    checkTypes: ["http_health", "http_status", "http_body"],
  },
  {
    id: "redis",
    label: "Redis",
    role: "dependency",
    status: "planned",
    checkTypes: ["dependency_ping"],
  },
  {
    id: "mysql",
    label: "MySQL",
    role: "restore",
    status: "planned",
    checkTypes: ["schema", "sql"],
  },
  {
    id: "s3",
    label: "Object storage",
    role: "dependency",
    status: "planned",
    checkTypes: ["dependency_ping"],
  },
  {
    id: "kubernetes",
    label: "Kubernetes workload",
    role: "application",
    status: "planned",
    checkTypes: ["http_health", "dependency_ping"],
  },
] as const;

export interface RecoveryContractRequired {
  database?: boolean;
  schema?: boolean;
  critical_queries?: boolean;
  api?: boolean;
  healthcheck?: boolean;
}

export interface RecoveryContractDefinition {
  version: string;
  recovery: {
    rto: string;
    rpo: string;
    required: RecoveryContractRequired;
    dependencies?: string[];
    application?: {
      healthcheck?: string;
      endpoints?: Array<{
        name: string;
        method: string;
        path: string;
        expect_status?: number;
      }>;
    };
    critical_queries?: Array<{ name: string; sql: string }>;
    checks?: string[];
    /** Hours before verification freshness becomes a warning */
    maxVerificationAgeHours?: number;
  };
}

export type DriftSeverity = "stable" | "minor_drift" | "recovery_at_risk" | "recovery_invalidated";

export interface RecoveryFingerprintPayload {
  database?: {
    engine: string;
    version?: string;
    sizeBytes?: number;
    schemaHash?: string;
    tableCount?: number;
  };
  application?: {
    version?: string;
    contractHash?: string;
  };
  dependencies?: string[];
  validationPlanVersion?: number;
}

export const DEFAULT_RECOVERY_CONTRACT: RecoveryContractDefinition = {
  version: "1",
  recovery: {
    rto: "15m",
    rpo: "5m",
    required: {
      database: true,
      schema: true,
      critical_queries: true,
      api: false,
      healthcheck: false,
    },
    dependencies: [],
    maxVerificationAgeHours: 168,
  },
};

/** Parse duration strings like 15m, 1h, 90s into seconds. */
export function parseDurationToSeconds(value: string): number | null {
  const trimmed = value.trim();
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/i.exec(trimmed);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multipliers: Record<string, number> = {
    ms: 0.001,
    s: 1,
    m: 60,
    h: 3600,
    d: 86400,
  };
  return Math.round(amount * multipliers[unit]);
}
