import type { DriftSeverity, RecoveryContractDefinition } from "./recovery-contract.js";
import { parseDurationToSeconds } from "./recovery-contract.js";

export type ReadinessDimensionStatus =
  | "pass"
  | "fail"
  | "warn"
  | "unknown"
  | "not_configured";

export type ReadinessOverallStatus =
  | "recovery_ready"
  | "at_risk"
  | "not_ready"
  | "unknown";

export interface ReadinessDimension {
  id: string;
  label: string;
  status: ReadinessDimensionStatus;
  detail?: string;
  weight: number;
}

export interface RecoveryRisk {
  severity: "warning" | "critical";
  message: string;
}

export interface RecoveryReadinessResult {
  score: number;
  status: ReadinessOverallStatus;
  dimensions: ReadinessDimension[];
  risks: RecoveryRisk[];
  rtoTargetSeconds: number | null;
  rtoActualSeconds: number | null;
  rpoTargetSeconds: number | null;
  rpoObservedSeconds: number | null;
  lastVerifiedAt: string | null;
  driftStatus: DriftSeverity;
  driftSummary: string | null;
}

const STATUS_SCORE: Record<ReadinessDimensionStatus, number> = {
  pass: 1,
  warn: 0.5,
  unknown: 0.25,
  not_configured: 0,
  fail: 0,
};

export function computeRecoveryReadiness(input: {
  contract: RecoveryContractDefinition;
  dimensions: ReadinessDimension[];
  driftStatus?: DriftSeverity;
  driftSummary?: string | null;
  lastVerifiedAt?: string | null;
  rtoActualSeconds?: number | null;
  rpoObservedSeconds?: number | null;
}): RecoveryReadinessResult {
  const rtoTargetSeconds = parseDurationToSeconds(input.contract.recovery.rto);
  const rpoTargetSeconds = parseDurationToSeconds(input.contract.recovery.rpo);

  // Only score dimensions that apply — not_configured items are out of scope for this workflow.
  const applicable = input.dimensions.filter((d) => d.status !== "not_configured");
  const totalWeight = applicable.reduce((sum, d) => sum + d.weight, 0);
  const earned =
    totalWeight > 0
      ? applicable.reduce((sum, d) => sum + d.weight * STATUS_SCORE[d.status], 0)
      : 0;
  const score = totalWeight > 0 ? Math.round((earned / totalWeight) * 100) : 0;

  const risks: RecoveryRisk[] = [];
  for (const dim of input.dimensions) {
    if (dim.status === "fail") {
      risks.push({ severity: "critical", message: `${dim.label}: ${dim.detail ?? "failed"}` });
    } else if (dim.status === "warn") {
      risks.push({ severity: "warning", message: `${dim.label}: ${dim.detail ?? "needs attention"}` });
    } else if (dim.status === "not_configured" && isRequiredDimension(dim.id, input.contract)) {
      risks.push({
        severity: "warning",
        message: `${dim.label} is required by your recovery contract but not configured`,
      });
    }
  }

  if (input.driftStatus === "recovery_at_risk" || input.driftStatus === "recovery_invalidated") {
    risks.push({
      severity: input.driftStatus === "recovery_invalidated" ? "critical" : "warning",
      message: input.driftSummary ?? "Recovery capability may have changed since last verification",
    });
  }

  const hasFail = input.dimensions.some((d) => d.status === "fail");

  // Overall tag reflects recovery capability (score + hard failures), not advisory gaps like
  // missing schedules or unmeasured RPO. Those stay visible in dimension rows and risks.
  let status: ReadinessOverallStatus = "unknown";
  if (!input.lastVerifiedAt) {
    status = "unknown";
  } else if (hasFail || input.driftStatus === "recovery_invalidated") {
    status = "not_ready";
  } else if (input.driftStatus === "recovery_at_risk" || score < 55) {
    status = "at_risk";
  } else if (score >= 80) {
    status = "recovery_ready";
  } else {
    status = "at_risk";
  }

  return {
    score,
    status,
    dimensions: input.dimensions,
    risks,
    rtoTargetSeconds,
    rtoActualSeconds: input.rtoActualSeconds ?? null,
    rpoTargetSeconds,
    rpoObservedSeconds: input.rpoObservedSeconds ?? null,
    lastVerifiedAt: input.lastVerifiedAt ?? null,
    driftStatus: input.driftStatus ?? "stable",
    driftSummary: input.driftSummary ?? null,
  };
}

function isRequiredDimension(id: string, contract: RecoveryContractDefinition): boolean {
  const req = contract.recovery.required;
  switch (id) {
    case "database_restore":
      return req.database === true;
    case "schema_integrity":
      return req.schema === true;
    case "critical_queries":
      return req.critical_queries === true;
    case "application_health":
      return req.healthcheck === true || req.api === true;
    default:
      return false;
  }
}

/** Parse Go-style durations embedded in CLI check messages (e.g. 2m30s, 1h5m). */
export function parseGoDurationToken(token: string): number | null {
  const trimmed = token.trim();
  if (!trimmed) return null;
  const re = /(\d+(?:\.\d+)?)(h|m|s)/gi;
  let total = 0;
  let matched = false;
  for (const part of trimmed.matchAll(re)) {
    matched = true;
    const value = Number(part[1]);
    const unit = part[2].toLowerCase();
    if (unit === "h") total += value * 3600;
    else if (unit === "m") total += value * 60;
    else total += value;
  }
  return matched ? Math.round(total) : null;
}

/** Observed RPO from freshness checks — max data lag on last drill. */
export function extractRpoObservedSeconds(
  checkResults: Array<{ checkType: string; status: string; message?: string | null }>
): number | null {
  let max: number | null = null;
  for (const r of checkResults) {
    if (r.checkType !== "freshness" || r.status !== "pass" || !r.message) continue;
    const match = r.message.match(/fresh:\s*([^\s]+)\s*<=/i);
    if (!match) continue;
    const seconds = parseGoDurationToken(match[1]);
    if (seconds == null) continue;
    max = max == null ? seconds : Math.max(max, seconds);
  }
  return max;
}

/** Build dimensions from the latest drill job + contract defaults. */
export function buildReadinessDimensionsFromJob(input: {
  contract: RecoveryContractDefinition;
  lastJobStatus: string | null;
  lastJobFinishedAt: string | null;
  rtoActualSeconds: number | null;
  rpoObservedSeconds: number | null;
  checkResults: Array<{ checkType: string; status: string; message?: string | null }>;
  hasValidationPlan: boolean;
  hasSchedule: boolean;
  dependencyCount: number;
  testedDependencyCount: number;
}): ReadinessDimension[] {
  const maxAgeHours = input.contract.recovery.maxVerificationAgeHours ?? 168;
  const rtoTarget = parseDurationToSeconds(input.contract.recovery.rto);

  const schemaChecks = input.checkResults.filter((r) =>
    ["schema", "table", "column", "index"].includes(r.checkType)
  );
  const queryChecks = input.checkResults.filter((r) =>
    ["sql", "row_count", "query", "freshness"].includes(r.checkType)
  );

  const schemaPass =
    schemaChecks.length === 0
      ? null
      : schemaChecks.every((c) => c.status === "pass");
  const queriesPass =
    queryChecks.length === 0
      ? null
      : queryChecks.every((c) => c.status === "pass");

  let restoreStatus: ReadinessDimensionStatus = "unknown";
  let restoreDetail = "No completed drill yet";
  if (input.lastJobStatus === "pass") {
    restoreStatus = "pass";
    restoreDetail = "Last drill passed";
  } else if (input.lastJobStatus === "fail" || input.lastJobStatus === "error") {
    restoreStatus = "fail";
    restoreDetail = `Last drill ${input.lastJobStatus}`;
  }

  let schemaStatus: ReadinessDimensionStatus = "unknown";
  if (!input.contract.recovery.required.schema) {
    schemaStatus = "not_configured";
  } else if (!input.hasValidationPlan) {
    schemaStatus = "warn";
    restoreDetail = "No validation plan";
  } else if (schemaPass === true) {
    schemaStatus = "pass";
  } else if (schemaPass === false) {
    schemaStatus = "fail";
  } else if (input.lastJobStatus === "pass") {
    schemaStatus = "pass";
  }

  let queriesStatus: ReadinessDimensionStatus = "unknown";
  if (!input.contract.recovery.required.critical_queries) {
    queriesStatus = "not_configured";
  } else if (queriesPass === true) {
    queriesStatus = "pass";
  } else if (queriesPass === false) {
    queriesStatus = "fail";
  } else if (input.lastJobStatus === "pass") {
    queriesStatus = "pass";
  }

  let rtoStatus: ReadinessDimensionStatus = "unknown";
  let rtoDetail: string | undefined;
  if (rtoTarget == null) {
    rtoStatus = "warn";
    rtoDetail = "Invalid RTO target in contract";
  } else if (input.rtoActualSeconds == null) {
    rtoStatus = "unknown";
    rtoDetail = "No RTO measurement yet";
  } else if (input.rtoActualSeconds <= rtoTarget) {
    rtoStatus = "pass";
    rtoDetail = `${input.rtoActualSeconds}s / ${rtoTarget}s target`;
  } else {
    rtoStatus = "fail";
    rtoDetail = `${input.rtoActualSeconds}s exceeds ${rtoTarget}s target`;
  }

  let freshnessStatus: ReadinessDimensionStatus = "unknown";
  let freshnessDetail: string | undefined;
  if (!input.lastJobFinishedAt) {
    freshnessStatus = "unknown";
    freshnessDetail = "Never verified";
  } else {
    const ageHours =
      (Date.now() - new Date(input.lastJobFinishedAt).getTime()) / 3_600_000;
    if (ageHours <= maxAgeHours) {
      freshnessStatus = "pass";
      freshnessDetail = `Verified ${Math.round(ageHours)}h ago`;
    } else {
      freshnessStatus = "warn";
      freshnessDetail = `Last verified ${Math.round(ageHours)}h ago (policy: ${maxAgeHours}h)`;
    }
  }

  const wantsApp =
    input.contract.recovery.required.api === true ||
    input.contract.recovery.required.healthcheck === true;
  const appConfigured = Boolean(input.contract.recovery.application?.healthcheck);
  const httpChecks = input.checkResults.filter((r) => r.checkType === "http_health");
  const httpPass =
    httpChecks.length === 0 ? null : httpChecks.every((c) => c.status === "pass");

  let appStatus: ReadinessDimensionStatus = "not_configured";
  let appDetail = "Application checks not in contract yet";
  if (!wantsApp) {
    appStatus = "not_configured";
  } else if (!appConfigured) {
    appStatus = "warn";
    appDetail = "Required by contract but no healthcheck URL configured";
  } else if (httpPass === true) {
    appStatus = "pass";
    appDetail = "Application healthcheck passed on last drill";
  } else if (httpPass === false) {
    appStatus = "fail";
    appDetail = "Application healthcheck failed on last drill";
  } else if (input.lastJobStatus === "pass") {
    appStatus = "warn";
    appDetail = "Healthcheck configured but no http_health result on last drill";
  } else {
    appStatus = "unknown";
    appDetail = "Healthcheck URL saved — run a drill to verify";
  }

  let depStatus: ReadinessDimensionStatus = "not_configured";
  let depDetail = "No dependencies in contract";
  if (input.dependencyCount > 0) {
    if (input.testedDependencyCount >= input.dependencyCount) {
      depStatus = "pass";
      depDetail = `${input.testedDependencyCount}/${input.dependencyCount} tested`;
    } else if (input.testedDependencyCount > 0) {
      depStatus = "warn";
      depDetail = `${input.testedDependencyCount}/${input.dependencyCount} tested`;
    } else {
      depStatus = "warn";
      depDetail = `${input.dependencyCount} dependencies not tested`;
    }
  }

  let procedureStatus: ReadinessDimensionStatus = "not_configured";
  let procedureDetail = "No schedule configured";
  if (input.hasSchedule) {
    procedureStatus = "pass";
    procedureDetail = "Scheduled drills enabled";
  } else if (input.hasValidationPlan && input.lastJobStatus === "pass") {
    procedureStatus = "warn";
    procedureDetail = "Manual drills only — add a schedule for automation";
  } else if (input.hasValidationPlan) {
    procedureStatus = "not_configured";
    procedureDetail = "Add a schedule after your first passing drill";
  }

  const rpoTarget = parseDurationToSeconds(input.contract.recovery.rpo);
  let rpoStatus: ReadinessDimensionStatus = "unknown";
  let rpoDetail = "Add a freshness check to your validation plan to measure data lag";
  if (rpoTarget == null) {
    rpoStatus = "warn";
    rpoDetail = "Invalid RPO target in contract";
  } else if (input.rpoObservedSeconds == null) {
    if (input.lastJobStatus === "pass") {
      rpoStatus = "warn";
      rpoDetail = "Drill passed but no freshness check — cannot measure RPO";
    } else {
      rpoStatus = "unknown";
    }
  } else if (input.rpoObservedSeconds <= rpoTarget) {
    rpoStatus = "pass";
    rpoDetail = `${input.rpoObservedSeconds}s lag / ${rpoTarget}s target`;
  } else {
    rpoStatus = "fail";
    rpoDetail = `${input.rpoObservedSeconds}s lag exceeds ${rpoTarget}s target`;
  }

  return [
    { id: "database_restore", label: "Database restore", status: restoreStatus, detail: restoreDetail, weight: 15 },
    { id: "schema_integrity", label: "Schema integrity", status: schemaStatus, weight: 12 },
    { id: "critical_queries", label: "Critical queries", status: queriesStatus, weight: 12 },
    { id: "application_health", label: "Application health", status: appStatus, detail: appDetail, weight: 10 },
    { id: "rto", label: "RTO", status: rtoStatus, detail: rtoDetail, weight: 15 },
    { id: "rpo", label: "RPO", status: rpoStatus, detail: rpoDetail, weight: 8 },
    { id: "dependencies", label: "Dependencies", status: depStatus, detail: depDetail, weight: 10 },
    { id: "recovery_procedure", label: "Recovery procedure", status: procedureStatus, detail: procedureDetail, weight: 8 },
    { id: "freshness", label: "Last verified", status: freshnessStatus, detail: freshnessDetail, weight: 10 },
  ];
}
