import {
  DescribeDBInstancesCommand,
  DescribeDBSnapshotsCommand,
  RDSClient,
} from "@aws-sdk/client-rds";
import { and, eq } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { databaseAwsCredentials, databases } from "../db/schema.js";
import { decryptSecret } from "../lib/crypto.js";
import { createAppError } from "../lib/errors.js";

export type AwsSourceStatus = {
  state: "available" | "unavailable" | "missing" | "not_configured" | "unknown";
  rdsStatus: string | null;
  availableSnapshotCount: number | null;
  latestSnapshotIdentifier: string | null;
  latestSnapshotCreatedAt: string | null;
  checkedAt: string;
  message: string | null;
};

const AWS_REQUEST_TIMEOUT_MS = 10_000;

function awsErrorName(error: unknown): string {
  if (error instanceof Error && "name" in error) return error.name;
  return "";
}

function isInstanceMissing(error: unknown): boolean {
  return [
    "DBInstanceNotFound",
    "DBInstanceNotFoundFault",
  ].includes(awsErrorName(error));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown AWS error";
}

function result(
  state: AwsSourceStatus["state"],
  values: Partial<Omit<AwsSourceStatus, "state" | "checkedAt">> = {}
): AwsSourceStatus {
  return {
    state,
    rdsStatus: null,
    availableSnapshotCount: null,
    latestSnapshotIdentifier: null,
    latestSnapshotCreatedAt: null,
    checkedAt: new Date().toISOString(),
    message: null,
    ...values,
  };
}

export async function checkAwsSourceStatus(
  db: Database,
  masterKey: string,
  organizationId: string,
  databaseId: string
): Promise<AwsSourceStatus> {
  const [database] = await db
    .select()
    .from(databases)
    .where(and(eq(databases.id, databaseId), eq(databases.organizationId, organizationId)))
    .limit(1);

  if (!database) {
    throw createAppError(404, "Database not found", "NOT_FOUND");
  }
  if (database.recoveryMode !== "aws-rds") {
    console.log(`[aws-source-check] database=${databaseId} skipped: recovery mode is direct`);
    return result("not_configured", { message: "This database is not configured for AWS RDS recovery." });
  }
  if (!database.region || !database.rdsSourceIdentifier) {
    console.warn(`[aws-source-check] database=${databaseId} AWS region or source identifier is missing`);
    return result("not_configured", { message: "Set the AWS region and source RDS identifier in database settings." });
  }

  const [credential] = await db
    .select()
    .from(databaseAwsCredentials)
    .where(
      and(
        eq(databaseAwsCredentials.databaseId, databaseId),
        eq(databaseAwsCredentials.organizationId, organizationId)
      )
    )
    .limit(1);
  if (!credential) {
    console.warn(`[aws-source-check] database=${databaseId} AWS credentials are missing`);
    return result("not_configured", { message: "AWS credentials are not configured for this database." });
  }

  let credentials: { accessKeyId?: string; secretAccessKey?: string; sessionToken?: string };
  try {
    credentials = JSON.parse(decryptSecret(credential, masterKey)) as typeof credentials;
  } catch (error) {
    console.error(
      `[aws-source-check] database=${databaseId} could not decrypt AWS credentials:`,
      errorMessage(error)
    );
    return result("unknown", { message: "Could not read the saved AWS credentials. Re-save them in database settings." });
  }
  if (!credentials.accessKeyId || !credentials.secretAccessKey) {
    console.warn(`[aws-source-check] database=${databaseId} saved AWS credentials are incomplete`);
    return result("not_configured", { message: "Saved AWS credentials are incomplete. Re-enter them in database settings." });
  }

  const sourceIdentifier = database.rdsSourceIdentifier;
  const region = database.region;
  const startedAt = Date.now();
  console.log(
    `[aws-source-check] database=${databaseId} starting source check ` +
      `region=${region} source=${sourceIdentifier}`
  );
  const client = new RDSClient({
    region,
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      ...(credentials.sessionToken ? { sessionToken: credentials.sessionToken } : {}),
    },
    maxAttempts: 1,
  });

  try {
    let rdsStatus: string | null = null;
    let sourceMissing = false;
    try {
      const response = await client.send(
        new DescribeDBInstancesCommand({ DBInstanceIdentifier: sourceIdentifier }),
        { abortSignal: AbortSignal.timeout(AWS_REQUEST_TIMEOUT_MS) }
      );
      rdsStatus = response.DBInstances?.[0]?.DBInstanceStatus ?? null;
      sourceMissing = !response.DBInstances?.[0];
    } catch (error) {
      if (isInstanceMissing(error)) {
        sourceMissing = true;
      } else {
        throw error;
      }
    }

    const availableSnapshots = [];
    let snapshotCheckError: string | null = null;
    if (sourceMissing) {
      try {
        for (const snapshotType of ["manual", "automated"] as const) {
          let marker: string | undefined;
          do {
            const response = await client.send(
              new DescribeDBSnapshotsCommand({
                DBInstanceIdentifier: sourceIdentifier,
                SnapshotType: snapshotType,
                ...(marker ? { Marker: marker } : {}),
              }),
              { abortSignal: AbortSignal.timeout(AWS_REQUEST_TIMEOUT_MS) }
            );
            availableSnapshots.push(
              ...(response.DBSnapshots ?? []).filter(
                (snapshot) =>
                  snapshot.Status === "available" && Boolean(snapshot.DBSnapshotIdentifier)
              )
            );
            marker = response.Marker;
          } while (marker);
        }
      } catch (error) {
        snapshotCheckError = errorMessage(error);
      }
    }

    availableSnapshots.sort(
      (a, b) =>
        (b.SnapshotCreateTime?.getTime() ?? 0) -
        (a.SnapshotCreateTime?.getTime() ?? 0)
    );
    const latestSnapshot = availableSnapshots[0];
    const state = sourceMissing
      ? "missing"
      : rdsStatus === "available"
        ? "available"
        : "unavailable";
    const status = result(state, {
      rdsStatus,
      availableSnapshotCount:
        sourceMissing && !snapshotCheckError ? availableSnapshots.length : null,
      latestSnapshotIdentifier: latestSnapshot?.DBSnapshotIdentifier ?? null,
      latestSnapshotCreatedAt: latestSnapshot?.SnapshotCreateTime?.toISOString() ?? null,
      message: sourceMissing
        ? snapshotCheckError
          ? `Source RDS instance was not found, and AWS could not verify its snapshots: ${snapshotCheckError}`
          : availableSnapshots.length > 0
            ? `Source RDS instance was not found. ${availableSnapshots.length} available snapshot(s) can still be used from Recovery Points.`
            : "Source RDS instance was not found and no available snapshots were found."
        : state === "unavailable"
          ? `Source RDS instance is ${rdsStatus ?? "in an unknown state"}; a full drill requires it to be available.`
          : null,
    });
    console.log(
      `[aws-source-check] database=${databaseId} state=${status.state} ` +
        `rdsStatus=${status.rdsStatus ?? "missing"} ` +
        `availableSnapshots=${status.availableSnapshotCount} duration=${Date.now() - startedAt}ms`
    );
    return status;
  } catch (error) {
    const message = errorMessage(error);
    console.error(
      `[aws-source-check] database=${databaseId} AWS check failed ` +
        `after ${Date.now() - startedAt}ms: ${message}`
    );
    return result("unknown", {
      message: `Could not verify this RDS instance in AWS: ${message}`,
    });
  } finally {
    client.destroy();
  }
}

export function assertAwsFullDrillSourceAvailable(status: AwsSourceStatus): void {
  if (status.state === "available") return;

  const message = status.state === "missing"
    ? `${status.message} A full drill was not queued. Use the workflow's Recovery Points tab to verify or recover an existing snapshot.`
    : status.state === "unavailable"
      ? `${status.message} A full drill was not queued.`
      : status.state === "not_configured"
        ? `${status.message} A full drill was not queued.`
        : `${status.message ?? "AWS source status could not be verified."} A full drill was not queued.`;
  const statusCode = status.state === "unknown" ? 503 : 409;
  throw createAppError(statusCode, message, "AWS_SOURCE_NOT_READY");
}
