/** Recovery Point — Revenant metadata over a customer-owned AWS RDS snapshot. */

export type RecoveryPointProvider = "aws-rds";

/** Who owns lifecycle of the underlying AWS snapshot. */
export type SnapshotOrigin = "customer_existing" | "revenant_managed" | "unknown";

export type RecoveryPointStatus = "active" | "superseded" | "deleted";

export type RecoveryVerificationStatus = "verified" | "failed" | "never";

export type RecoveryRunType = "verify" | "recover" | "create_snapshot";

export type RecoveryRunStatus =
  | "pending"
  | "running"
  | "pass"
  | "fail"
  | "error"
  | "cancelled";

export type RecoveryInstanceStatus =
  | "creating"
  | "available"
  | "deleting"
  | "deleted"
  | "cleanup_failed"
  | "retained"
  | "failed"
  | "modifying"
  | "backing-up"
  | "rebooting"
  | "starting";

export interface RecoveryPointResource {
  id: string;
  databaseId: string;
  databaseName: string;
  provider: RecoveryPointProvider;
  region: string | null;
  sourceDbIdentifier: string | null;
  snapshotIdentifier: string;
  snapshotArn: string | null;
  engine: string | null;
  engineVersion: string | null;
  snapshotCreatedAt: string | null;
  snapshotOrigin: SnapshotOrigin;
  status: RecoveryPointStatus;
  lastVerifiedAt: string | null;
  lastVerificationStatus: RecoveryVerificationStatus;
  lastVerificationJobId: string | null;
  lastCleanupStatus: string | null;
  lastTemporaryInstanceIdentifier: string | null;
  lastRtoSeconds: number | null;
  lastRpoObservedSeconds: number | null;
  validationPlanVersion: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface RecoveryRunResource {
  id: string;
  recoveryPointId: string;
  jobId: string | null;
  runType: RecoveryRunType;
  status: RecoveryRunStatus;
  cleanupStatus: string | null;
  startedAt: string | null;
  completedAt: string | null;
  rtoSeconds: number | null;
  errorMessage: string | null;
  createdAt: string;
}

export interface RecoveryInstanceResource {
  id: string;
  recoveryRunId: string;
  awsDbInstanceIdentifier: string;
  endpoint: string | null;
  port: number | null;
  region: string | null;
  instanceClass: string | null;
  temporary: boolean;
  status: RecoveryInstanceStatus;
  createdAt: string;
  deletedAt: string | null;
}

/** Parse RDS snapshot id from CLI check messages. */
export function parseAwsSnapshotIdentifier(message?: string | null): string | null {
  if (!message) return null;
  const snap = message.match(/(snap-[a-z0-9-]+)/i)?.[1];
  if (snap) return snap;
  const arn = message.match(/arn:aws:rds:[^:]+:[^:]+:snapshot:([^/\s]+)/i)?.[1];
  return arn ?? null;
}

export function snapshotOriginLabel(origin: SnapshotOrigin): string {
  switch (origin) {
    case "revenant_managed":
      return "Created during a Revenant drill";
    case "customer_existing":
      return "Your existing AWS snapshot";
    default:
      return "AWS snapshot";
  }
}

export function recoveryRunTypeLabel(type: RecoveryRunType): string {
  switch (type) {
    case "verify":
      return "Verification";
    case "recover":
      return "Recovery";
    case "create_snapshot":
      return "Snapshot capture";
  }
}
