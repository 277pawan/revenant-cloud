import {
  DeleteDBSnapshotCommand,
  DeleteDBInstanceCommand,
  DescribeDBSnapshotsCommand,
  DescribeDBInstancesCommand,
  RDSClient,
  AddTagsToResourceCommand,
} from "@aws-sdk/client-rds";
import { and, eq, inArray } from "drizzle-orm";
import type { Database } from "../db/index.js";
import {
  databaseAwsCredentials,
  databases,
  jobResults,
  jobs,
} from "../db/schema.js";
import { decryptSecret } from "../lib/crypto.js";

const STALE_RUN_GRACE_MS = 10 * 60_000;
const ACTIVE_RUN_EXTENSION_MS = 10 * 60_000;
const DELETE_POLL_MS = 10_000;
const DELETE_TIMEOUT_MS = 10 * 60_000;

type TemporaryResourceTags = {
  managedBy: string;
  purpose: string;
  databaseId: string;
  runId: string;
  expiresAt: Date | null;
};

function readTemporaryTags(
  tags: Array<{ Key?: string; Value?: string }> | undefined
): TemporaryResourceTags {
  const values = new Map(tags?.map((tag) => [tag.Key, tag.Value]));
  const expiresValue = values.get("ExpiresAt");
  const expiresAt = expiresValue ? new Date(expiresValue) : null;
  return {
    managedBy: values.get("ManagedBy") ?? "",
    purpose: values.get("Purpose") ?? "",
    databaseId: values.get("DatabaseId") ?? "",
    runId: values.get("RunId") ?? "",
    expiresAt: expiresAt && Number.isNaN(expiresAt.getTime()) ? null : expiresAt,
  };
}

function isTemporaryRecoveryResource(tags: TemporaryResourceTags): boolean {
  return tags.managedBy === "Revenant" &&
    tags.purpose === "RecoveryValidation" &&
    tags.databaseId.length > 0 &&
    tags.runId.length > 0;
}

function hasRevenantSnapshotOwnership(
  tags: Array<{ Key?: string; Value?: string }> | undefined
): boolean {
  return tags?.some(
    (tag) =>
      (tag.Key === "ManagedBy" && tag.Value === "Revenant") ||
      (tag.Key === "revenant:managed" && tag.Value === "true")
  ) ?? false;
}

function isInstanceNotFound(error: unknown): boolean {
  return error instanceof Error &&
    ["DBInstanceNotFound", "DBInstanceNotFoundFault"].includes(error.name);
}

async function waitForDeletion(
  client: RDSClient,
  identifier: string
): Promise<void> {
  const deadline = Date.now() + DELETE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await client.send(
        new DescribeDBInstancesCommand({ DBInstanceIdentifier: identifier }),
        { abortSignal: AbortSignal.timeout(15_000) }
      );
      const status = response.DBInstances?.[0]?.DBInstanceStatus;
      if (!status) return;
      if (status !== "deleting") {
        throw new Error(`RDS instance entered unexpected state ${status} during deletion`);
      }
    } catch (error) {
      if (isInstanceNotFound(error)) return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, DELETE_POLL_MS));
  }
  throw new Error(`timed out waiting for RDS instance ${identifier} to be deleted`);
}

function isSnapshotNotFound(error: unknown): boolean {
  return error instanceof Error &&
    ["DBSnapshotNotFound", "DBSnapshotNotFoundFault"].includes(error.name);
}

async function waitForSnapshotDeletion(
  client: RDSClient,
  identifier: string
): Promise<void> {
  const deadline = Date.now() + DELETE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await client.send(
        new DescribeDBSnapshotsCommand({ DBSnapshotIdentifier: identifier }),
        { abortSignal: AbortSignal.timeout(15_000) }
      );
      const status = response.DBSnapshots?.[0]?.Status;
      if (!status) return;
      if (status !== "deleting") {
        throw new Error(`RDS snapshot entered unexpected state ${status} during deletion`);
      }
    } catch (error) {
      if (isSnapshotNotFound(error)) return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, DELETE_POLL_MS));
  }
  throw new Error(`timed out waiting for RDS snapshot ${identifier} to be deleted`);
}

async function recordCleanupFailure(
  db: Database,
  organizationId: string,
  runId: string,
  resourceId: string,
  checkName: string,
  message: string
): Promise<void> {
  const [existingFailure] = await db
    .select({ id: jobResults.id })
    .from(jobResults)
    .where(
      and(
        eq(jobResults.jobId, runId),
        eq(jobResults.checkType, "cleanup"),
        eq(jobResults.checkName, checkName),
        eq(jobResults.status, "fail")
      )
    )
    .limit(1);
  if (!existingFailure) {
    await db.insert(jobResults).values({
      organizationId,
      jobId: runId,
      checkName,
      checkType: "cleanup",
      status: "fail",
      message: `Revenant RDS resource ${resourceId} cleanup failed: ${message}`.slice(0, 2000),
      durationMs: 0,
    });
  }

  const finishedAt = new Date();
  await db
    .update(jobs)
    .set({
      status: "fail",
      errorMessage: `Revenant RDS resource ${resourceId} cleanup failed: ${message}`.slice(0, 2000),
      finishedAt,
      updatedAt: finishedAt,
    })
    .where(
      and(
        eq(jobs.id, runId),
        inArray(jobs.status, ["running", "pass"])
      )
    );
}

async function recordCleanupSuccess(
  db: Database,
  organizationId: string,
  runId: string,
  resourceId: string,
  checkName: string
): Promise<void> {
  const cleanupResults = await db
    .select({ status: jobResults.status })
    .from(jobResults)
    .where(
      and(
        eq(jobResults.jobId, runId),
        eq(jobResults.checkType, "cleanup"),
        eq(jobResults.checkName, checkName)
      )
    );
  const completedAt = new Date();
  const message = `Revenant RDS resource ${resourceId} cleanup completed by TTL reconciliation.`;
  if (cleanupResults.some((result) => result.status !== "pass")) {
    await db
      .update(jobResults)
      .set({ status: "pass", message, createdAt: completedAt })
      .where(
        and(
          eq(jobResults.jobId, runId),
          eq(jobResults.checkType, "cleanup"),
          eq(jobResults.checkName, checkName),
          inArray(jobResults.status, ["fail", "skip", "error"])
        )
      );
  } else if (cleanupResults.length === 0) {
    await db.insert(jobResults).values({
      organizationId,
      jobId: runId,
      checkName,
      checkType: "cleanup",
      status: "pass",
      message,
      durationMs: 0,
      createdAt: completedAt,
    });
  }
}

export async function reconcileTemporaryRecoveryResources(
  db: Database,
  masterKey: string
): Promise<{ inspected: number; deleted: number; extended: number; errors: string[] }> {
  const summary = { inspected: 0, deleted: 0, extended: 0, errors: [] as string[] };
  const awsDatabases = await db
    .select()
    .from(databases)
    .where(eq(databases.recoveryMode, "aws-rds"));

  for (const database of awsDatabases) {
    if (database.recoveryMaxLifetimeMinutes === null) {
      console.log(
        `[recovery-reconciler] retention disabled database=${database.id}; keeping all snapshots and restores`
      );
      continue;
    }
    const [credential] = await db
      .select()
      .from(databaseAwsCredentials)
      .where(
        and(
          eq(databaseAwsCredentials.databaseId, database.id),
          eq(databaseAwsCredentials.organizationId, database.organizationId)
        )
      )
      .limit(1);
    if (!credential || !database.region) continue;

    try {
      const awsCredentials = JSON.parse(decryptSecret(credential, masterKey)) as {
        accessKeyId?: string;
        secretAccessKey?: string;
        sessionToken?: string;
      };
      if (!awsCredentials.accessKeyId || !awsCredentials.secretAccessKey) {
        throw new Error("saved AWS credentials are incomplete");
      }

      const client = new RDSClient({
        region: database.region,
        credentials: {
          accessKeyId: awsCredentials.accessKeyId,
          secretAccessKey: awsCredentials.secretAccessKey,
          ...(awsCredentials.sessionToken
            ? { sessionToken: awsCredentials.sessionToken }
            : {}),
        },
        maxAttempts: 1,
      });
      try {
        let marker: string | undefined;
        do {
          const page = await client.send(
            new DescribeDBInstancesCommand({ Marker: marker }),
            { abortSignal: AbortSignal.timeout(30_000) }
          );
          for (const instance of page.DBInstances ?? []) {
            summary.inspected++;
            const identifier = instance.DBInstanceIdentifier;
            if (!identifier) continue;
            const tags = readTemporaryTags(instance.TagList);
            if (!isTemporaryRecoveryResource(tags) || tags.databaseId !== database.id) continue;

            if (!tags.expiresAt) {
              if (!instance.DBInstanceArn) {
                throw new Error(`RDS instance ${identifier} has no ARN for TTL tag update`);
              }
              const expiresAt = new Date(
                Date.now() + database.recoveryMaxLifetimeMinutes * 60_000
              );
              await client.send(
                new AddTagsToResourceCommand({
                  ResourceName: instance.DBInstanceArn,
                  Tags: [{ Key: "ExpiresAt", Value: expiresAt.toISOString() }],
                }),
                { abortSignal: AbortSignal.timeout(15_000) }
              );
              summary.extended++;
              console.log(
                `[recovery-reconciler] started retention for previously retained RDS instance=${identifier} ` +
                  `expiresAt=${expiresAt.toISOString()}`
              );
              continue;
            }

            const [run] = await db
              .select({ status: jobs.status, updatedAt: jobs.updatedAt })
              .from(jobs)
              .where(
                and(
                  eq(jobs.id, tags.runId),
                  eq(jobs.databaseId, tags.databaseId),
                  eq(jobs.organizationId, database.organizationId)
                )
              )
              .limit(1);
            const heartbeatAt = run?.updatedAt.getTime() ?? 0;
            const heartbeatFresh =
              run?.status === "running" &&
              Date.now() - heartbeatAt <= STALE_RUN_GRACE_MS;
            const expiration = tags.expiresAt!.getTime();

            if (run?.status === "running" && heartbeatFresh) {
              if (expiration <= Date.now()) {
                if (!instance.DBInstanceArn) {
                  throw new Error(`RDS instance ${identifier} has no ARN for TTL tag update`);
                }
                const extendedUntil = new Date(Date.now() + ACTIVE_RUN_EXTENSION_MS);
                await client.send(
                  new AddTagsToResourceCommand({
                    ResourceName: instance.DBInstanceArn,
                    Tags: [
                      {
                        Key: "ExpiresAt",
                        Value: extendedUntil.toISOString(),
                      },
                    ],
                  }),
                  { abortSignal: AbortSignal.timeout(15_000) }
                );
                summary.extended++;
                console.log(
                  `[recovery-reconciler] extended active temporary RDS resource=${identifier} ` +
                    `run=${tags.runId} expiresAt=${extendedUntil.toISOString()}`
                );
              }
              continue;
            }

            if (expiration + STALE_RUN_GRACE_MS > Date.now()) continue;
            if (
              instance.DBInstanceStatus !== "available" &&
              instance.DBInstanceStatus !== "stopped" &&
              instance.DBInstanceStatus !== "failed" &&
              instance.DBInstanceStatus !== "incompatible-restore"
            ) {
              console.log(
                `[recovery-reconciler] deferring expired RDS resource=${identifier} ` +
                  `status=${instance.DBInstanceStatus ?? "unknown"}`
              );
              continue;
            }

            console.warn(
              `[recovery-reconciler] deleting expired temporary RDS resource=${identifier} ` +
                `run=${tags.runId} expiredAt=${tags.expiresAt!.toISOString()}`
            );
            try {
              await client.send(
                new DeleteDBInstanceCommand({
                  DBInstanceIdentifier: identifier,
                  SkipFinalSnapshot: true,
                }),
                { abortSignal: AbortSignal.timeout(30_000) }
              );
            } catch (error) {
              if (!isInstanceNotFound(error)) {
                const message = error instanceof Error ? error.message : "Unknown AWS error";
                if (run) {
                  await recordCleanupFailure(
                    db,
                    database.organizationId,
                    tags.runId,
                    identifier,
                    "temp_instance_cleanup",
                    message
                  );
                }
                summary.errors.push(`${identifier}: ${message}`);
                console.error(
                  `[recovery-reconciler] resource=${identifier} delete failed: ${message}`
                );
                continue;
              }
            }
            try {
              await waitForDeletion(client, identifier);
            } catch (error) {
              const message = error instanceof Error ? error.message : "Unknown AWS error";
              if (run) {
                await recordCleanupFailure(
                  db,
                  database.organizationId,
                  tags.runId,
                  identifier,
                  "temp_instance_cleanup",
                  message
                );
              }
              summary.errors.push(`${identifier}: ${message}`);
              console.error(
                `[recovery-reconciler] resource=${identifier} deletion verification failed: ${message}`
              );
              continue;
            }
            if (run) {
              await recordCleanupSuccess(
                db,
                database.organizationId,
                tags.runId,
                identifier,
                "temp_instance_cleanup"
              );
            }
            summary.deleted++;
          }
          marker = page.Marker;
        } while (marker);

        let snapshotMarker: string | undefined;
        do {
          const page = await client.send(
            new DescribeDBSnapshotsCommand({
              SnapshotType: "manual",
              Marker: snapshotMarker,
            }),
            { abortSignal: AbortSignal.timeout(30_000) }
          );
          for (const snapshot of page.DBSnapshots ?? []) {
            summary.inspected++;
            const identifier = snapshot.DBSnapshotIdentifier;
            if (!identifier) continue;
            const tags = readTemporaryTags(snapshot.TagList);
            if (!isTemporaryRecoveryResource(tags) || tags.databaseId !== database.id) continue;

            if (!tags.expiresAt) {
              if (!snapshot.DBSnapshotArn) {
                throw new Error(`RDS snapshot ${identifier} has no ARN for TTL tag update`);
              }
              const expiresAt = new Date(
                Date.now() + database.recoveryMaxLifetimeMinutes * 60_000
              );
              await client.send(
                new AddTagsToResourceCommand({
                  ResourceName: snapshot.DBSnapshotArn,
                  Tags: [{ Key: "ExpiresAt", Value: expiresAt.toISOString() }],
                }),
                { abortSignal: AbortSignal.timeout(15_000) }
              );
              summary.extended++;
              console.log(
                `[recovery-reconciler] started retention for previously retained RDS snapshot=${identifier} ` +
                  `expiresAt=${expiresAt.toISOString()}`
              );
              continue;
            }

            const [run] = await db
              .select({ status: jobs.status, updatedAt: jobs.updatedAt })
              .from(jobs)
              .where(
                and(
                  eq(jobs.id, tags.runId),
                  eq(jobs.databaseId, tags.databaseId),
                  eq(jobs.organizationId, database.organizationId)
                )
              )
              .limit(1);
            const expiration = tags.expiresAt!.getTime();
            const heartbeatFresh =
              run?.status === "running" &&
              Date.now() - run.updatedAt.getTime() <= STALE_RUN_GRACE_MS;

            if (heartbeatFresh) {
              if (expiration <= Date.now()) {
                if (!snapshot.DBSnapshotArn) {
                  throw new Error(`RDS snapshot ${identifier} has no ARN for TTL tag update`);
                }
                const extendedUntil = new Date(Date.now() + ACTIVE_RUN_EXTENSION_MS);
                await client.send(
                  new AddTagsToResourceCommand({
                    ResourceName: snapshot.DBSnapshotArn,
                    Tags: [{ Key: "ExpiresAt", Value: extendedUntil.toISOString() }],
                  }),
                  { abortSignal: AbortSignal.timeout(15_000) }
                );
                summary.extended++;
                console.log(
                  `[recovery-reconciler] extended active Revenant snapshot=${identifier} ` +
                    `run=${tags.runId} expiresAt=${extendedUntil.toISOString()}`
                );
              }
              continue;
            }
            if (expiration + STALE_RUN_GRACE_MS > Date.now()) continue;

            const status = snapshot.Status ?? "unknown";
            if (status !== "available" && status !== "deleting") {
              console.log(
                `[recovery-reconciler] deferring expired Revenant snapshot=${identifier} status=${status}`
              );
              continue;
            }

            try {
              if (status !== "deleting") {
                await client.send(
                  new DeleteDBSnapshotCommand({ DBSnapshotIdentifier: identifier }),
                  { abortSignal: AbortSignal.timeout(30_000) }
                );
              }
            } catch (error) {
              if (!isSnapshotNotFound(error)) {
                const message = error instanceof Error ? error.message : "Unknown AWS error";
                if (run) {
                  await recordCleanupFailure(
                    db,
                    database.organizationId,
                    tags.runId,
                    identifier,
                    "drill_snapshot_cleanup",
                    message
                  );
                }
                summary.errors.push(`${identifier}: ${message}`);
                console.error(`[recovery-reconciler] snapshot=${identifier} delete failed: ${message}`);
                continue;
              }
            }
            try {
              await waitForSnapshotDeletion(client, identifier);
            } catch (error) {
              const message = error instanceof Error ? error.message : "Unknown AWS error";
              if (run) {
                await recordCleanupFailure(
                  db,
                  database.organizationId,
                  tags.runId,
                  identifier,
                  "drill_snapshot_cleanup",
                  message
                );
              }
              summary.errors.push(`${identifier}: ${message}`);
              console.error(
                `[recovery-reconciler] snapshot=${identifier} deletion verification failed: ${message}`
              );
              continue;
            }
            if (run) {
              await recordCleanupSuccess(
                db,
                database.organizationId,
                tags.runId,
                identifier,
                "drill_snapshot_cleanup"
              );
            }
            summary.deleted++;
          }
          snapshotMarker = page.Marker;
        } while (snapshotMarker);

        if (
          database.recoveryCleanupCustomerSnapshots === "true" &&
          database.recoveryMaxLifetimeMinutes !== null &&
          database.rdsSourceIdentifier
        ) {
          let customerSnapshotMarker: string | undefined;
          do {
            const page = await client.send(
              new DescribeDBSnapshotsCommand({
                DBInstanceIdentifier: database.rdsSourceIdentifier,
                SnapshotType: "manual",
                Marker: customerSnapshotMarker,
              }),
              { abortSignal: AbortSignal.timeout(30_000) }
            );
            for (const snapshot of page.DBSnapshots ?? []) {
              summary.inspected++;
              const identifier = snapshot.DBSnapshotIdentifier;
              if (
                !identifier ||
                snapshot.DBInstanceIdentifier !== database.rdsSourceIdentifier ||
                hasRevenantSnapshotOwnership(snapshot.TagList)
              ) {
                continue;
              }
              const createdAt = snapshot.SnapshotCreateTime?.getTime();
              if (
                createdAt === undefined ||
                createdAt + database.recoveryMaxLifetimeMinutes * 60_000 > Date.now()
              ) {
                continue;
              }

              const status = snapshot.Status ?? "unknown";
              if (status !== "available" && status !== "deleting") {
                console.log(
                  `[recovery-reconciler] deferring expired customer manual snapshot=${identifier} ` +
                    `status=${status} source=${database.rdsSourceIdentifier}`
                );
                continue;
              }

              console.warn(
                `[recovery-reconciler] deleting opted-in customer manual snapshot=${identifier} ` +
                  `source=${database.rdsSourceIdentifier} createdAt=${snapshot.SnapshotCreateTime?.toISOString()}`
              );
              try {
                if (status !== "deleting") {
                  await client.send(
                    new DeleteDBSnapshotCommand({ DBSnapshotIdentifier: identifier }),
                    { abortSignal: AbortSignal.timeout(30_000) }
                  );
                }
                await waitForSnapshotDeletion(client, identifier);
                summary.deleted++;
              } catch (error) {
                if (isSnapshotNotFound(error)) {
                  summary.deleted++;
                  continue;
                }
                const message = error instanceof Error ? error.message : "Unknown AWS error";
                summary.errors.push(`${identifier}: ${message}`);
                console.error(
                  `[recovery-reconciler] opted-in customer snapshot=${identifier} cleanup failed: ${message}`
                );
              }
            }
            customerSnapshotMarker = page.Marker;
          } while (customerSnapshotMarker);
        }
      } finally {
        client.destroy();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown AWS error";
      summary.errors.push(`${database.id}: ${message}`);
      console.error(
        `[recovery-reconciler] database=${database.id} failed: ${message}`
      );
    }
  }

  console.log(
    `[recovery-reconciler] completed inspected=${summary.inspected} ` +
      `deleted=${summary.deleted} extended=${summary.extended} errors=${summary.errors.length}`
  );
  return summary;
}
