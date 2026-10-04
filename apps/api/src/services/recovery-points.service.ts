import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  DeleteDBSnapshotCommand,
  DescribeDBInstancesCommand,
  DescribeDBSnapshotsCommand,
  RDSClient,
  RestoreDBInstanceFromDBSnapshotCommand,
} from "@aws-sdk/client-rds";
import {
  extractRpoObservedSeconds,
  parseAwsSnapshotIdentifier,
  type JobDetailResource,
  type RecoveryInstanceResource,
  type RecoveryPointResource,
  type RecoveryRunResource,
  type RecoveryRunType,
  type SnapshotOrigin,
} from "@revenant/shared";
import type { Database } from "../db/index.js";
import {
  databases,
  databaseAwsCredentials,
  jobs,
  recoveryInstances,
  recoveryPoints,
  recoveryRuns,
  validationPlans,
} from "../db/schema.js";
import { createAppError } from "../lib/errors.js";
import { decryptSecret } from "../lib/crypto.js";
import { normalizeAwsIamCredentials } from "../lib/aws-credentials.js";
import { isMissingRelationError, migrationRequiredMessage } from "../lib/pg-errors.js";
import type { JobsService } from "./jobs.service.js";

const AWS_REQUEST_TIMEOUT_MS = 15_000;

function toPointResource(
  row: typeof recoveryPoints.$inferSelect,
  databaseName: string
): RecoveryPointResource {
  return {
    id: row.id,
    databaseId: row.databaseId,
    databaseName,
    provider: row.provider as RecoveryPointResource["provider"],
    region: row.region,
    sourceDbIdentifier: row.sourceDbIdentifier,
    snapshotIdentifier: row.snapshotIdentifier,
    snapshotArn: row.snapshotArn,
    engine: row.engine,
    engineVersion: row.engineVersion,
    snapshotCreatedAt: row.snapshotCreatedAt?.toISOString() ?? null,
    snapshotOrigin: row.snapshotOrigin as SnapshotOrigin,
    status: row.status as RecoveryPointResource["status"],
    lastVerifiedAt: row.lastVerifiedAt?.toISOString() ?? null,
    lastVerificationStatus: row.lastVerificationStatus as RecoveryPointResource["lastVerificationStatus"],
    lastVerificationJobId: row.lastVerificationJobId,
    lastCleanupStatus: null,
    lastTemporaryInstanceIdentifier: null,
    lastRtoSeconds: row.lastRtoSeconds,
    lastRpoObservedSeconds: row.lastRpoObservedSeconds,
    validationPlanVersion: row.validationPlanVersion,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toRunResource(row: typeof recoveryRuns.$inferSelect): RecoveryRunResource {
  return {
    id: row.id,
    recoveryPointId: row.recoveryPointId,
    jobId: row.jobId,
    runType: row.runType as RecoveryRunResource["runType"],
    status: row.status as RecoveryRunResource["status"],
    cleanupStatus: row.cleanupStatus,
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    rtoSeconds: row.rtoSeconds,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt.toISOString(),
  };
}

function inferRunType(job: JobDetailResource): RecoveryRunType {
  const hasSnapshot = job.results.some((r) => r.checkType === "snapshot");
  if (hasSnapshot && (job.trigger === "full-drill" || job.trigger === "schedule")) {
    return "create_snapshot";
  }
  return "verify";
}

function inferSnapshotOrigin(job: JobDetailResource): SnapshotOrigin {
  if (job.trigger === "full-drill" || job.trigger === "schedule") {
    const created = job.results.some((r) => r.checkType === "snapshot" && r.status === "pass");
    if (created) return "revenant_managed";
  }
  return "customer_existing";
}

function resolveSnapshotIdentifier(job: JobDetailResource, finishedAt: Date): string {
  const registeredSnapshot = job.results
    .find((result) => result.checkType === "recovery_snapshot")
    ?.message?.match(/snapshot_identifier=([a-z0-9-]+)/i)?.[1];
  if (registeredSnapshot) return registeredSnapshot;
  const snapResult = job.results.find((r) => r.checkType === "snapshot");
  const parsed = parseAwsSnapshotIdentifier(snapResult?.message);
  if (parsed) return parsed;
  return `latest-verified-${finishedAt.toISOString().slice(0, 10)}`;
}

function resolveSnapshotArn(job: JobDetailResource): string | null {
  const message = job.results.find((result) => result.checkType === "recovery_snapshot")?.message;
  return message?.match(/snapshot_arn=([^;\s]+)/i)?.[1] ?? null;
}

type SnapshotCandidate = {
  DBSnapshotIdentifier?: string;
  DBSnapshotArn?: string;
  SnapshotCreateTime?: Date;
  Status?: string;
  Engine?: string;
  EngineVersion?: string;
};

export function selectSnapshotAtVerificationTime(
  snapshots: SnapshotCandidate[],
  verificationStartedAt: Date
): SnapshotCandidate | null {
  const eligible = snapshots
    .filter(
      (snapshot) =>
        snapshot.Status === "available" &&
        snapshot.DBSnapshotIdentifier &&
        snapshot.SnapshotCreateTime &&
        snapshot.SnapshotCreateTime <= verificationStartedAt
    )
    .sort(
      (a, b) =>
        b.SnapshotCreateTime!.getTime() - a.SnapshotCreateTime!.getTime()
    );
  return eligible[0] ?? null;
}

async function findSnapshotAtVerificationTime(
  client: RDSClient,
  sourceIdentifier: string,
  verificationStartedAt: Date
) {
  const snapshots: SnapshotCandidate[] = [];
  let marker: string | undefined;
  do {
    const response = await client.send(
      new DescribeDBSnapshotsCommand({
        DBInstanceIdentifier: sourceIdentifier,
        ...(marker ? { Marker: marker } : {}),
      }),
      { abortSignal: AbortSignal.timeout(AWS_REQUEST_TIMEOUT_MS) }
    );
    snapshots.push(...(response.DBSnapshots ?? []));
    marker = response.Marker;
  } while (marker);
  return selectSnapshotAtVerificationTime(snapshots, verificationStartedAt);
}

async function listSnapshots(client: RDSClient, sourceIdentifier: string) {
  const snapshots = new Map<string, SnapshotCandidate>();
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
      for (const snapshot of response.DBSnapshots ?? []) {
        if (!snapshot.DBSnapshotIdentifier) continue;
        snapshots.set(snapshot.DBSnapshotIdentifier, snapshot);
      }
      marker = response.Marker;
    } while (marker);
  }
  return [...snapshots.values()];
}

export function findMissingRecoveryPointIds(
  points: Array<{ id: string; snapshotIdentifier: string }>,
  awsSnapshotIdentifiers: Set<string>
): string[] {
  return points
    .filter(
      (point) =>
        !point.snapshotIdentifier.startsWith("latest-verified-") &&
        !awsSnapshotIdentifiers.has(point.snapshotIdentifier)
    )
    .map((point) => point.id);
}

export type RecoverFromPointInput = {
  targetIdentifier: string;
  confirmTargetIdentifier: string;
  dbSubnetGroupName?: string;
  vpcSecurityGroupIds?: string[];
  instanceClass?: string;
  resolveOnly?: boolean;
};

type SourceRecoveryInstance = {
  DBSubnetGroup?: { DBSubnetGroupName?: string };
  VpcSecurityGroups?: Array<{ VpcSecurityGroupId?: string }>;
  DBInstanceClass?: string;
};

export function resolveRecoverySettings(
  input: Pick<RecoverFromPointInput, "dbSubnetGroupName" | "vpcSecurityGroupIds" | "instanceClass">,
  sourceInstance: SourceRecoveryInstance,
  configuredInstanceClass?: string | null,
  allowDefaultNetwork = false
) {
  const dbSubnetGroupName =
    input.dbSubnetGroupName?.trim() || sourceInstance.DBSubnetGroup?.DBSubnetGroupName;
  const vpcSecurityGroupIds = input.vpcSecurityGroupIds?.length
    ? input.vpcSecurityGroupIds
    : (sourceInstance.VpcSecurityGroups ?? [])
        .map((group) => group.VpcSecurityGroupId)
        .filter((id): id is string => Boolean(id));
  const hasPartialNetworkSettings = Boolean(dbSubnetGroupName) !== (vpcSecurityGroupIds.length > 0);
  if (
    hasPartialNetworkSettings ||
    (!allowDefaultNetwork && (!dbSubnetGroupName || vpcSecurityGroupIds.length === 0))
  ) {
    throw createAppError(
      409,
      "Provide both a DB subnet group and at least one VPC security group, or use the source instance network settings.",
      "SOURCE_NETWORK_SETTINGS_UNAVAILABLE"
    );
  }
  return {
    dbSubnetGroupName,
    vpcSecurityGroupIds,
    instanceClass:
      input.instanceClass?.trim() ||
      configuredInstanceClass ||
      sourceInstance.DBInstanceClass ||
      "db.t3.micro",
  };
}

export function validateRecoveryTarget(
  input: RecoverFromPointInput,
  sourceIdentifier: string | null
): string {
  const targetIdentifier = input.targetIdentifier.trim().toLowerCase();
  if (
    !/^[a-z][a-z0-9-]{0,62}$/.test(targetIdentifier) ||
    targetIdentifier.includes("--") ||
    targetIdentifier.endsWith("-")
  ) {
    throw createAppError(400, "Target identifier must be a valid AWS RDS name", "INVALID_TARGET_IDENTIFIER");
  }
  if (input.confirmTargetIdentifier !== input.targetIdentifier) {
    throw createAppError(400, "Type the target identifier exactly to confirm recovery", "RECOVERY_CONFIRMATION_MISMATCH");
  }
  if (sourceIdentifier?.toLowerCase() === targetIdentifier) {
    throw createAppError(400, "Target name cannot match the source production database", "PRODUCTION_TARGET_FORBIDDEN");
  }
  return targetIdentifier;
}

function toInstanceResource(
  row: typeof recoveryInstances.$inferSelect
): RecoveryInstanceResource {
  return {
    id: row.id,
    recoveryRunId: row.recoveryRunId,
    awsDbInstanceIdentifier: row.awsDbInstanceIdentifier,
    endpoint: row.endpoint,
    port: row.port,
    region: row.region,
    instanceClass: row.instanceClass,
    temporary: row.temporary === "true",
    status: row.status as RecoveryInstanceResource["status"],
    createdAt: row.createdAt.toISOString(),
    deletedAt: row.deletedAt?.toISOString() ?? null,
  };
}

function isRdsInstanceNotFound(error: unknown): boolean {
  return [
    "DBInstanceNotFound",
    "DBInstanceNotFoundFault",
  ].includes(awsErrorName(error));
}

function awsErrorName(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const candidate = error as { name?: string; Code?: string; code?: string };
  return candidate.name ?? candidate.Code ?? candidate.code ?? "";
}

function awsErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "AWS RDS request failed";
}

export function createRecoveryPointsService(
  db: Database,
  jobsService: JobsService,
  masterKey: string
) {
  async function loadAwsCredentials(organizationId: string, databaseId: string) {
    const [credential] = await db
      .select()
      .from(databaseAwsCredentials)
      .where(
        and(
          eq(databaseAwsCredentials.organizationId, organizationId),
          eq(databaseAwsCredentials.databaseId, databaseId)
        )
      )
      .limit(1);
    if (!credential) {
      throw createAppError(400, "Add AWS credentials to this database before recovering", "AWS_CREDENTIALS_REQUIRED");
    }
    const decrypted = decryptSecret(credential, masterKey);
    const parsed = JSON.parse(decrypted) as {
      accessKeyId?: string;
      secretAccessKey?: string;
      sessionToken?: string;
    };
    try {
      return normalizeAwsIamCredentials(parsed);
    } catch (error) {
      throw createAppError(
        400,
        error instanceof Error ? error.message : "AWS credentials are incomplete",
        "AWS_CREDENTIALS_REQUIRED"
      );
    }
  }

  async function loadDatabase(organizationId: string, databaseId: string) {
    const [database] = await db
      .select()
      .from(databases)
      .where(and(eq(databases.id, databaseId), eq(databases.organizationId, organizationId)))
      .limit(1);
    if (!database) throw createAppError(404, "Database not found", "NOT_FOUND");
    if (database.recoveryMode !== "aws-rds" || !database.region) {
      throw createAppError(400, "Recovery requires an AWS RDS database with a region", "INVALID_RECOVERY_MODE");
    }
    return database;
  }

  function createRdsClient(region: string, credentials: Awaited<ReturnType<typeof loadAwsCredentials>>) {
    return new RDSClient({ region, credentials, maxAttempts: 1 });
  }

  async function discoverAvailableRecoveryPoints(
    organizationId: string,
    databaseId: string
  ): Promise<void> {
    const [database] = await db
      .select()
      .from(databases)
      .where(and(eq(databases.id, databaseId), eq(databases.organizationId, organizationId)))
      .limit(1);
    if (
      !database ||
      database.recoveryMode !== "aws-rds" ||
      !database.region ||
      !database.rdsSourceIdentifier
    ) return;

    const credentials = await loadAwsCredentials(organizationId, databaseId);
    const client = createRdsClient(database.region, credentials);
    const startedAt = Date.now();
    console.log(
      `[recovery] discovering AWS snapshots database=${databaseId} ` +
        `region=${database.region} source=${database.rdsSourceIdentifier}`
    );
    try {
      const snapshots = await listSnapshots(client, database.rdsSourceIdentifier);
      const awsSnapshotIdentifiers = new Set(
        snapshots.map((snapshot) => snapshot.DBSnapshotIdentifier).filter(
          (identifier): identifier is string => Boolean(identifier)
        )
      );
      const availableSnapshots = snapshots.filter((snapshot) => snapshot.Status === "available");
      for (const snapshot of availableSnapshots) {
        if (!snapshot.DBSnapshotIdentifier) continue;
        await db
          .insert(recoveryPoints)
          .values({
            organizationId,
            databaseId,
            provider: "aws-rds",
            region: database.region,
            sourceDbIdentifier: database.rdsSourceIdentifier,
            snapshotIdentifier: snapshot.DBSnapshotIdentifier,
            snapshotArn: snapshot.DBSnapshotArn ?? null,
            engine: snapshot.Engine ?? database.engine,
            engineVersion: snapshot.EngineVersion ?? null,
            snapshotCreatedAt: snapshot.SnapshotCreateTime ?? null,
            snapshotOrigin: "unknown",
            lastVerificationStatus: "never",
          })
          .onConflictDoNothing({
            target: [
              recoveryPoints.organizationId,
              recoveryPoints.databaseId,
              recoveryPoints.snapshotIdentifier,
            ],
          });
      }
      const trackedPoints = await db
        .select({
          id: recoveryPoints.id,
          snapshotIdentifier: recoveryPoints.snapshotIdentifier,
        })
        .from(recoveryPoints)
        .where(
          and(
            eq(recoveryPoints.organizationId, organizationId),
            eq(recoveryPoints.databaseId, databaseId),
            eq(recoveryPoints.status, "active")
          )
        );
      const missingPointIds = findMissingRecoveryPointIds(
        trackedPoints,
        awsSnapshotIdentifiers
      );
      if (missingPointIds.length > 0) {
        await db
          .update(recoveryPoints)
          .set({ status: "deleted", updatedAt: new Date() })
          .where(inArray(recoveryPoints.id, missingPointIds));
      }
      console.log(
        `[recovery] snapshot discovery complete database=${databaseId} ` +
          `available=${availableSnapshots.length} staleRemoved=${missingPointIds.length} ` +
          `duration=${Date.now() - startedAt}ms`
      );
    } catch (error) {
      console.error(
        `[recovery] AWS snapshot discovery/reconciliation failed database=${databaseId} ` +
          `after ${Date.now() - startedAt}ms: ${awsErrorMessage(error)}`
      );
      throw createAppError(
        502,
        `Could not reconcile recovery points with AWS for this database: ${awsErrorMessage(error)}`,
        "AWS_SNAPSHOT_DISCOVERY_FAILED"
      );
    } finally {
      client.destroy();
    }
  }

  return {
    async listForDatabase(
      organizationId: string,
      databaseId: string,
      includeDeleted = false
    ): Promise<RecoveryPointResource[]> {
      try {
        await this.backfillFromRecentJobs(organizationId, databaseId);
        await discoverAvailableRecoveryPoints(organizationId, databaseId);

        const rows = await db
          .select({
            point: recoveryPoints,
            databaseName: databases.name,
          })
          .from(recoveryPoints)
          .innerJoin(databases, eq(databases.id, recoveryPoints.databaseId))
          .where(and(
            eq(recoveryPoints.organizationId, organizationId),
            eq(recoveryPoints.databaseId, databaseId),
            ...(includeDeleted ? [] : [eq(recoveryPoints.status, "active")])
          ))
          .orderBy(
            sql`${recoveryPoints.snapshotCreatedAt} DESC NULLS LAST`,
            desc(recoveryPoints.createdAt)
          );

        const pointResources = rows.map((r) => toPointResource(r.point, r.databaseName));
        if (pointResources.length === 0) return pointResources;

        const pointIds = pointResources.map((point) => point.id);
        const runs = await db
          .select()
          .from(recoveryRuns)
          .where(
            and(
              eq(recoveryRuns.organizationId, organizationId),
              inArray(recoveryRuns.recoveryPointId, pointIds)
            )
          )
          .orderBy(desc(recoveryRuns.createdAt));
        const latestRunByPoint = new Map<string, (typeof runs)[number]>();
        for (const run of runs) {
          if (run.cleanupStatus && !latestRunByPoint.has(run.recoveryPointId)) {
            latestRunByPoint.set(run.recoveryPointId, run);
          }
        }
        const latestRunIds = [...latestRunByPoint.values()].map((run) => run.id);
        const instances = latestRunIds.length
          ? await db
              .select()
              .from(recoveryInstances)
              .where(inArray(recoveryInstances.recoveryRunId, latestRunIds))
          : [];
        const instanceByRun = new Map(
          instances.map((instance) => [instance.recoveryRunId, instance.awsDbInstanceIdentifier])
        );

        return pointResources.map((point) => {
          const run = latestRunByPoint.get(point.id);
          return {
            ...point,
            lastCleanupStatus: run?.cleanupStatus ?? null,
            lastTemporaryInstanceIdentifier: run
              ? instanceByRun.get(run.id) ?? null
              : null,
          };
        });
      } catch (err) {
        if (isMissingRelationError(err)) {
          throw createAppError(
            503,
            migrationRequiredMessage("Recovery points"),
            "MIGRATION_REQUIRED"
          );
        }
        throw err;
      }
    },

    async deleteSnapshot(
      organizationId: string,
      recoveryPointId: string
    ): Promise<{ deletedFromAws: boolean }> {
      const point = await this.getById(organizationId, recoveryPointId);
      if (point.snapshotIdentifier.startsWith("latest-verified-")) {
        throw createAppError(
          409,
          "This legacy recovery point has no exact AWS snapshot ID and cannot be deleted safely.",
          "SNAPSHOT_IDENTIFIER_REQUIRED"
        );
      }
      const database = await loadDatabase(organizationId, point.databaseId);
      const credentials = await loadAwsCredentials(organizationId, point.databaseId);
      const client = createRdsClient(database.region!, credentials);
      try {
        let snapshot;
        try {
          const response = await client.send(new DescribeDBSnapshotsCommand({
            DBSnapshotIdentifier: point.snapshotArn ?? point.snapshotIdentifier,
          }), { abortSignal: AbortSignal.timeout(AWS_REQUEST_TIMEOUT_MS) });
          snapshot = response.DBSnapshots?.[0];
        } catch (error) {
          if (["DBSnapshotNotFound", "DBSnapshotNotFoundFault"].includes(awsErrorName(error))) {
            await db.update(recoveryPoints)
              .set({ status: "deleted", updatedAt: new Date() })
              .where(eq(recoveryPoints.id, point.id));
            return { deletedFromAws: true };
          }
          throw createAppError(
            502,
            `Could not inspect the AWS snapshot before deletion: ${awsErrorMessage(error)}`,
            "AWS_SNAPSHOT_LOOKUP_FAILED"
          );
        }
        if (!snapshot) {
          await db.update(recoveryPoints)
            .set({ status: "deleted", updatedAt: new Date() })
            .where(eq(recoveryPoints.id, point.id));
          return { deletedFromAws: true };
        }
        if (snapshot.SnapshotType !== "manual") {
          await db.update(recoveryPoints)
            .set({ status: "deleted", updatedAt: new Date() })
            .where(eq(recoveryPoints.id, point.id));
          return { deletedFromAws: false };
        }
        await client.send(new DeleteDBSnapshotCommand({
          DBSnapshotIdentifier: snapshot.DBSnapshotIdentifier ?? point.snapshotIdentifier,
        }), { abortSignal: AbortSignal.timeout(AWS_REQUEST_TIMEOUT_MS) });
        await db.update(recoveryPoints)
          .set({ status: "deleted", updatedAt: new Date() })
          .where(eq(recoveryPoints.id, point.id));
        return { deletedFromAws: true };
      } catch (error) {
        if (error instanceof Error && "statusCode" in error) throw error;
        throw createAppError(
          502,
          `AWS could not delete the snapshot: ${awsErrorMessage(error)}`,
          "AWS_SNAPSHOT_DELETE_FAILED"
        );
      } finally {
        client.destroy();
      }
    },

    async getById(organizationId: string, id: string): Promise<RecoveryPointResource> {
      const [row] = await db
        .select({
          point: recoveryPoints,
          databaseName: databases.name,
        })
        .from(recoveryPoints)
        .innerJoin(databases, eq(databases.id, recoveryPoints.databaseId))
        .where(
          and(eq(recoveryPoints.id, id), eq(recoveryPoints.organizationId, organizationId))
        )
        .limit(1);

      if (!row) {
        throw createAppError(404, "Recovery point not found", "NOT_FOUND");
      }
      return toPointResource(row.point, row.databaseName);
    },

    async listRuns(
      organizationId: string,
      recoveryPointId: string,
      limit = 20
    ): Promise<RecoveryRunResource[]> {
      const rows = await db
        .select()
        .from(recoveryRuns)
        .where(
          and(
            eq(recoveryRuns.organizationId, organizationId),
            eq(recoveryRuns.recoveryPointId, recoveryPointId)
          )
        )
        .orderBy(desc(recoveryRuns.createdAt))
        .limit(limit);

      return rows.map(toRunResource);
    },

    /** Register or update metadata after any AWS drill job completes. */
    async syncFromJob(organizationId: string, job: JobDetailResource): Promise<void> {
      const [registeredRun] = await db
        .select({ id: recoveryRuns.id })
        .from(recoveryRuns)
        .where(and(
          eq(recoveryRuns.organizationId, organizationId),
          eq(recoveryRuns.jobId, job.id)
        ))
        .limit(1);
      if (registeredRun) return;

      const [dbRow] = await db
        .select()
        .from(databases)
        .where(
          and(eq(databases.id, job.databaseId), eq(databases.organizationId, organizationId))
        )
        .limit(1);

      if (!dbRow || dbRow.recoveryMode !== "aws-rds") return;

      const finishedAt = job.finishedAt ? new Date(job.finishedAt) : new Date();
      const snapshotId = resolveSnapshotIdentifier(job, finishedAt);
      const snapshotArn = resolveSnapshotArn(job);
      const runType = inferRunType(job);
      const origin = inferSnapshotOrigin(job);
      const rpo = extractRpoObservedSeconds(job.results);
      const verificationStatus = job.status === "pass" ? "verified" : "failed";
      const cleanupResult = job.results.find((result) => result.checkType === "cleanup");
      const cleanupStatus = inferCleanupStatus(job);
      const temporaryInstanceIdentifier = parseTemporaryInstanceIdentifier(job);

      const [planRow] = await db
        .select({ version: validationPlans.version })
        .from(validationPlans)
        .where(eq(validationPlans.databaseId, job.databaseId))
        .limit(1);

      const [existing] = await db
        .select()
        .from(recoveryPoints)
        .where(
          and(
            eq(recoveryPoints.organizationId, organizationId),
            eq(recoveryPoints.databaseId, job.databaseId),
            eq(recoveryPoints.snapshotIdentifier, snapshotId)
          )
        )
        .limit(1);

      let pointId: string;

      if (existing) {
        const [updated] = await db
          .update(recoveryPoints)
          .set({
            lastVerifiedAt: job.status === "pass" ? finishedAt : existing.lastVerifiedAt,
            lastVerificationStatus:
              job.status === "pass" ? "verified" : existing.lastVerificationStatus,
            lastVerificationJobId: job.status === "pass" ? job.id : existing.lastVerificationJobId,
            lastRtoSeconds: job.rtoSeconds ?? existing.lastRtoSeconds,
            lastRpoObservedSeconds: rpo ?? existing.lastRpoObservedSeconds,
            snapshotArn: snapshotArn ?? existing.snapshotArn,
            validationPlanVersion: planRow?.version ?? existing.validationPlanVersion,
            snapshotOrigin:
              origin === "revenant_managed" ? "revenant_managed" : existing.snapshotOrigin,
            updatedAt: new Date(),
          })
          .where(eq(recoveryPoints.id, existing.id))
          .returning({ id: recoveryPoints.id });
        pointId = updated.id;
      } else {
        const [inserted] = await db
          .insert(recoveryPoints)
          .values({
            organizationId,
            databaseId: job.databaseId,
            provider: "aws-rds",
            region: dbRow.region,
            sourceDbIdentifier: dbRow.rdsSourceIdentifier,
            snapshotIdentifier: snapshotId,
            snapshotArn,
            engine: dbRow.engine,
            snapshotCreatedAt: runType === "create_snapshot" ? finishedAt : null,
            snapshotOrigin: origin,
            lastVerifiedAt: job.status === "pass" ? finishedAt : null,
            lastVerificationStatus: verificationStatus,
            lastVerificationJobId: job.status === "pass" ? job.id : null,
            lastRtoSeconds: job.rtoSeconds,
            lastRpoObservedSeconds: rpo,
            validationPlanVersion: planRow?.version ?? null,
          })
          .returning({ id: recoveryPoints.id });
        pointId = inserted.id;
      }

      const [run] = await db.insert(recoveryRuns).values({
        organizationId,
        recoveryPointId: pointId,
        jobId: job.id,
        runType,
        status: job.status,
        startedAt: job.startedAt ? new Date(job.startedAt) : null,
        completedAt: finishedAt,
        rtoSeconds: job.rtoSeconds,
        errorMessage: job.errorMessage,
        cleanupStatus,
        metadataJson: { trigger: job.trigger },
      }).returning({ id: recoveryRuns.id });

      if (cleanupResult && temporaryInstanceIdentifier) {
        const cleanupState = cleanupStatus === "failed"
          ? "cleanup_failed"
          : cleanupStatus === "retained"
            ? "retained"
            : cleanupStatus === "completed"
              ? "deleted"
              : "deleting";
        await db.insert(recoveryInstances).values({
          organizationId,
          recoveryRunId: run.id,
          awsDbInstanceIdentifier: temporaryInstanceIdentifier,
          region: dbRow.region,
          temporary: "true",
          status: cleanupState,
          deletedAt: cleanupState === "deleted" ? finishedAt : null,
        });
      }
    },

    async verifyAgain(
      organizationId: string,
      userId: string,
      recoveryPointId: string
    ): Promise<{ recoveryPoint: RecoveryPointResource; job: { id: string } }> {
      const point = await this.getById(organizationId, recoveryPointId);

      const job = await jobsService.create(organizationId, userId, {
        databaseId: point.databaseId,
        drillKind: "verify",
        recoveryPointId: point.id,
      });

      return { recoveryPoint: point, job: { id: job.id } };
    },

    async recoverFromPoint(
      organizationId: string,
      recoveryPointId: string,
      input: RecoverFromPointInput
    ): Promise<{
      resolvedOnly: true;
      recoveryPointId: string;
      snapshotIdentifier: string;
    } | {
      resolvedOnly: false;
      runId: string;
      recoveryPointId: string;
      snapshotIdentifier: string;
      instance: RecoveryInstanceResource;
    }> {
      let point = await this.getById(organizationId, recoveryPointId);
      const database = await loadDatabase(organizationId, point.databaseId);
      const targetIdentifier = validateRecoveryTarget(input, database.rdsSourceIdentifier);
      const recoveryStartedAt = Date.now();
      console.log(
        `[recovery] starting recoveryPoint=${point.id} database=${point.databaseId} ` +
          `region=${database.region} target=${targetIdentifier}`
      );

      const credentials = await loadAwsCredentials(organizationId, point.databaseId);
      const client = createRdsClient(database.region!, credentials);
      const resolvingLegacyPoint = point.snapshotIdentifier.startsWith("latest-verified-");
      let snapshot;
      if (resolvingLegacyPoint) {
        if (!point.sourceDbIdentifier) {
          client.destroy();
          throw createAppError(
            409,
            "This legacy recovery point has no source database identifier, so its AWS snapshot cannot be matched safely.",
            "SNAPSHOT_IDENTIFIER_REQUIRED"
          );
        }
        const [verificationJob] = point.lastVerificationJobId
          ? await db
              .select({ startedAt: jobs.startedAt })
              .from(jobs)
              .where(
                and(
                  eq(jobs.id, point.lastVerificationJobId),
                  eq(jobs.organizationId, organizationId)
                )
              )
              .limit(1)
          : [];
        const verificationStartedAt = verificationJob?.startedAt ??
          (point.lastVerifiedAt ? new Date(point.lastVerifiedAt) : null);
        if (!verificationStartedAt) {
          client.destroy();
          throw createAppError(
            409,
            "This legacy recovery point has no verification time, so its AWS snapshot cannot be matched safely.",
            "SNAPSHOT_IDENTIFIER_REQUIRED"
          );
        }
        try {
          snapshot = await findSnapshotAtVerificationTime(
            client,
            point.sourceDbIdentifier,
            verificationStartedAt
          );
        } catch (error) {
          client.destroy();
          throw createAppError(502, `Could not match the verified AWS snapshot: ${awsErrorMessage(error)}`, "AWS_SNAPSHOT_LOOKUP_FAILED");
        }
        if (!snapshot) {
          client.destroy();
          throw createAppError(
            404,
            "No available AWS snapshot from this source existed when the recovery point was verified.",
            "SNAPSHOT_NOT_FOUND"
          );
        }

        const snapshotIdentifier = snapshot.DBSnapshotIdentifier!;
        const [registeredPoint] = await db
          .select()
          .from(recoveryPoints)
          .where(
            and(
              eq(recoveryPoints.organizationId, organizationId),
              eq(recoveryPoints.databaseId, point.databaseId),
              eq(recoveryPoints.snapshotIdentifier, snapshotIdentifier)
            )
          )
          .limit(1);

        if (registeredPoint && registeredPoint.id !== point.id) {
          const fallbackIsNewer =
            point.lastVerifiedAt !== null &&
            (!registeredPoint.lastVerifiedAt ||
              new Date(point.lastVerifiedAt) > registeredPoint.lastVerifiedAt);
          await db
            .update(recoveryRuns)
            .set({ recoveryPointId: registeredPoint.id, updatedAt: new Date() })
            .where(
              and(
                eq(recoveryRuns.organizationId, organizationId),
                eq(recoveryRuns.recoveryPointId, point.id)
              )
            );
          await db
            .update(recoveryPoints)
            .set({ status: "superseded", updatedAt: new Date() })
            .where(eq(recoveryPoints.id, point.id));
          await db
            .update(recoveryPoints)
            .set({
              snapshotArn: snapshot.DBSnapshotArn ?? registeredPoint.snapshotArn,
              snapshotCreatedAt: snapshot.SnapshotCreateTime ?? registeredPoint.snapshotCreatedAt,
              ...(fallbackIsNewer
                ? {
                    lastVerifiedAt: point.lastVerifiedAt
                      ? new Date(point.lastVerifiedAt)
                      : registeredPoint.lastVerifiedAt,
                    lastVerificationStatus: point.lastVerificationStatus,
                    lastVerificationJobId: point.lastVerificationJobId,
                    lastRtoSeconds: point.lastRtoSeconds ?? registeredPoint.lastRtoSeconds,
                    lastRpoObservedSeconds:
                      point.lastRpoObservedSeconds ?? registeredPoint.lastRpoObservedSeconds,
                  }
                : {}),
              updatedAt: new Date(),
            })
            .where(eq(recoveryPoints.id, registeredPoint.id));
          point = await this.getById(organizationId, registeredPoint.id);
        } else {
          await db
            .update(recoveryPoints)
            .set({
              snapshotIdentifier,
              snapshotArn: snapshot.DBSnapshotArn ?? null,
              snapshotCreatedAt: snapshot.SnapshotCreateTime ?? null,
              updatedAt: new Date(),
            })
            .where(eq(recoveryPoints.id, point.id));
          point = {
            ...point,
            snapshotIdentifier,
            snapshotArn: snapshot.DBSnapshotArn ?? null,
            snapshotCreatedAt: snapshot.SnapshotCreateTime?.toISOString() ?? null,
          };
        }
      } else {
        try {
          const response = await client.send(new DescribeDBSnapshotsCommand({
            DBSnapshotIdentifier: point.snapshotArn ?? point.snapshotIdentifier,
          }), { abortSignal: AbortSignal.timeout(AWS_REQUEST_TIMEOUT_MS) });
          snapshot = response.DBSnapshots?.[0];
        } catch (error) {
          client.destroy();
          throw createAppError(502, `Could not inspect the selected AWS snapshot: ${awsErrorMessage(error)}`, "AWS_SNAPSHOT_LOOKUP_FAILED");
        }
      }
      if (!snapshot) {
        client.destroy();
        throw createAppError(404, "The selected snapshot was not found in AWS", "SNAPSHOT_NOT_FOUND");
      }
      if (snapshot.Status !== "available") {
        client.destroy();
        throw createAppError(409, `Snapshot is not ready to restore (AWS status: ${snapshot.Status ?? "unknown"})`, "SNAPSHOT_NOT_READY");
      }
      console.log(`[recovery] selected snapshot is available recoveryPoint=${point.id}`);
      if (resolvingLegacyPoint && !input.resolveOnly) {
        client.destroy();
        throw createAppError(
          409,
          "Review the resolved AWS snapshot ID before starting a restore.",
          "SNAPSHOT_CONFIRMATION_REQUIRED"
        );
      }
      if (input.resolveOnly) {
        client.destroy();
        return {
          resolvedOnly: true,
          recoveryPointId: point.id,
          snapshotIdentifier: point.snapshotIdentifier,
        };
      }

      const sourceIdentifier = database.rdsSourceIdentifier?.trim();
      if (!sourceIdentifier) {
        client.destroy();
        throw createAppError(
          400,
          "Set the source RDS instance identifier before starting recovery.",
          "RDS_SOURCE_IDENTIFIER_REQUIRED"
        );
      }
      let sourceInstance;
      let sourceMissing = false;
      try {
        const sourceResponse = await client.send(
          new DescribeDBInstancesCommand({ DBInstanceIdentifier: sourceIdentifier }),
          { abortSignal: AbortSignal.timeout(AWS_REQUEST_TIMEOUT_MS) }
        );
        sourceInstance = sourceResponse.DBInstances?.[0];
      } catch (error) {
        if (isRdsInstanceNotFound(error)) {
          sourceMissing = true;
        } else {
          client.destroy();
          throw createAppError(
            502,
            `Could not read network settings from the source RDS instance: ${awsErrorMessage(error)}`,
            "AWS_SOURCE_INSTANCE_LOOKUP_FAILED"
          );
        }
      }
      if (!sourceInstance) sourceMissing = true;
      if (sourceMissing) {
        console.warn(
          `[recovery] source RDS instance=${sourceIdentifier} was not found; ` +
            "the restore will use AWS default networking unless both network settings are supplied"
        );
      }
      let recoverySettings;
      try {
        recoverySettings = resolveRecoverySettings(
          input,
          sourceInstance ?? {},
          database.recoverySandboxInstanceClass,
          sourceMissing
        );
      } catch (error) {
        client.destroy();
        throw error;
      }

      try {
        const existing = await client.send(new DescribeDBInstancesCommand({
          DBInstanceIdentifier: targetIdentifier,
        }), { abortSignal: AbortSignal.timeout(AWS_REQUEST_TIMEOUT_MS) });
        if (existing.DBInstances?.length) {
          throw createAppError(409, "An RDS instance with this target name already exists. Choose a new name; Revenant never overwrites instances.", "TARGET_ALREADY_EXISTS");
        }
      } catch (error) {
        if (error instanceof Error && "statusCode" in error) {
          client.destroy();
          throw error;
        }
        if (![
          "DBInstanceNotFound",
          "DBInstanceNotFoundFault",
        ].includes(awsErrorName(error))) {
          client.destroy();
          throw createAppError(502, `Could not check the recovery target: ${awsErrorMessage(error)}`, "AWS_TARGET_LOOKUP_FAILED");
        }
      }

      const startedAt = new Date();
      const { dbSubnetGroupName, vpcSecurityGroupIds, instanceClass } = recoverySettings;
      const [run] = await db.insert(recoveryRuns).values({
        organizationId,
        recoveryPointId: point.id,
        runType: "recover",
        status: "running",
        startedAt,
        metadataJson: {
          targetIdentifier,
          dbSubnetGroupName,
          vpcSecurityGroupIds,
          usedDefaultNetwork: sourceMissing && !dbSubnetGroupName,
        },
      }).returning({ id: recoveryRuns.id });
      const [instance] = await db.insert(recoveryInstances).values({
        organizationId,
        recoveryRunId: run.id,
        awsDbInstanceIdentifier: targetIdentifier,
        region: database.region,
        instanceClass,
        temporary: "false",
        status: "creating",
      }).returning();

      let restored;
      try {
        restored = await client.send(new RestoreDBInstanceFromDBSnapshotCommand({
          DBInstanceIdentifier: targetIdentifier,
          DBSnapshotIdentifier: snapshot.DBSnapshotArn ?? point.snapshotArn ?? point.snapshotIdentifier,
          DBInstanceClass: instanceClass,
          ...(dbSubnetGroupName ? { DBSubnetGroupName: dbSubnetGroupName } : {}),
          ...(vpcSecurityGroupIds.length > 0 ? { VpcSecurityGroupIds: vpcSecurityGroupIds } : {}),
          PubliclyAccessible: false,
          MultiAZ: false,
          Tags: [
            { Key: "revenant:purpose", Value: "retained-recovery" },
            { Key: "revenant:database-id", Value: point.databaseId },
            { Key: "revenant:recovery-point-id", Value: point.id },
            { Key: "revenant:recovery-run-id", Value: run.id },
          ],
        }), { abortSignal: AbortSignal.timeout(AWS_REQUEST_TIMEOUT_MS) });
      } catch (error) {
        client.destroy();
        await db.update(recoveryInstances).set({ status: "failed" }).where(eq(recoveryInstances.id, instance.id));
        await db.update(recoveryRuns).set({
          status: "fail",
          completedAt: new Date(),
          errorMessage: awsErrorMessage(error).slice(0, 1000),
        }).where(eq(recoveryRuns.id, run.id));
        throw createAppError(502, `AWS could not start the restore: ${awsErrorMessage(error)}`, "AWS_RESTORE_FAILED");
      }
      console.log(
        `[recovery] AWS accepted restore recoveryPoint=${point.id} target=${targetIdentifier} ` +
          `duration=${Date.now() - recoveryStartedAt}ms`
      );

      try {
        const created = restored.DBInstance;
        await db.update(recoveryInstances).set({
          status: created?.DBInstanceStatus ?? "creating",
          endpoint: created?.Endpoint?.Address ?? null,
          port: created?.Endpoint?.Port ?? null,
          instanceClass: created?.DBInstanceClass ?? instanceClass,
        }).where(eq(recoveryInstances.id, instance.id));
      } catch {
        console.error(
          `[recovery] AWS accepted restore target=${targetIdentifier}, ` +
            "but its initial status could not be saved; instance polling will reconcile it"
        );
      }
      client.destroy();
      console.log(
        `[recovery] recovery request recorded recoveryPoint=${point.id} ` +
          `instance=${instance.id} duration=${Date.now() - recoveryStartedAt}ms`
      );

      return {
        resolvedOnly: false,
        runId: run.id,
        recoveryPointId: point.id,
        snapshotIdentifier: point.snapshotIdentifier,
        instance: toInstanceResource(instance),
      };
    },

    async listRecoveryInstances(
      organizationId: string,
      recoveryPointId: string
    ): Promise<RecoveryInstanceResource[]> {
      const point = await this.getById(organizationId, recoveryPointId);
      const records = await db
        .select({ instance: recoveryInstances, run: recoveryRuns })
        .from(recoveryInstances)
        .innerJoin(recoveryRuns, eq(recoveryRuns.id, recoveryInstances.recoveryRunId))
        .where(and(
          eq(recoveryRuns.organizationId, organizationId),
          eq(recoveryRuns.recoveryPointId, recoveryPointId),
          eq(recoveryRuns.runType, "recover"),
          eq(recoveryInstances.temporary, "false")
        ))
        .orderBy(desc(recoveryInstances.createdAt));
      if (records.length === 0) return [];

      const database = await loadDatabase(organizationId, point.databaseId);
      let client: RDSClient | null = null;
      try {
        client = createRdsClient(
          database.region!,
          await loadAwsCredentials(organizationId, point.databaseId)
        );
      } catch (error) {
        console.warn(
          `[recovery] could not load AWS credentials for restore status database=${point.databaseId}; ` +
            `returning last saved state: ${awsErrorMessage(error)}`
        );
        return records.map((record) => toInstanceResource(record.instance));
      }

      const resources: RecoveryInstanceResource[] = [];
      for (const record of records) {
        let instance = record.instance;
        if (instance.status !== "available" && instance.status !== "failed" && instance.status !== "deleted") {
          console.log(
            `[recovery] polling restored instance=${instance.awsDbInstanceIdentifier} ` +
              `lastStatus=${instance.status}`
          );
          try {
            const response = await client.send(new DescribeDBInstancesCommand({
              DBInstanceIdentifier: instance.awsDbInstanceIdentifier,
            }), { abortSignal: AbortSignal.timeout(AWS_REQUEST_TIMEOUT_MS) });
            const awsInstance = response.DBInstances?.[0];
            if (awsInstance) {
              const awsStatus = awsInstance.DBInstanceStatus ?? "creating";
              const isAvailable = awsStatus === "available";
              const isFailed = /failed|incompatible|restore-error/i.test(awsStatus);
              const [updated] = await db.update(recoveryInstances).set({
                status: isFailed ? "failed" : awsStatus,
                endpoint: awsInstance.Endpoint?.Address ?? instance.endpoint,
                port: awsInstance.Endpoint?.Port ?? instance.port,
                instanceClass: awsInstance.DBInstanceClass ?? instance.instanceClass,
              }).where(eq(recoveryInstances.id, instance.id)).returning();
              instance = updated;
              if (awsStatus !== record.instance.status) {
                console.log(
                  `[recovery] restored instance=${instance.awsDbInstanceIdentifier} ` +
                    `status=${awsStatus}`
                );
              }
              if (isAvailable || isFailed) {
                await db.update(recoveryRuns).set({
                  status: isAvailable ? "pass" : "fail",
                  completedAt: new Date(),
                  errorMessage: isFailed ? `AWS restore entered ${awsStatus}` : null,
                }).where(eq(recoveryRuns.id, record.run.id));
              }
            }
          } catch (error) {
            if (awsErrorName(error) !== "DBInstanceNotFound") {
              console.warn(
                `[recovery] restore status check failed instance=${instance.awsDbInstanceIdentifier}; ` +
                  `returning last saved state=${instance.status}: ${awsErrorMessage(error)}`
              );
            }
          }
        }
        resources.push(toInstanceResource(instance));
      }
        client.destroy();
      return resources;
    },

    async backfillFromRecentJobs(organizationId: string, databaseId: string): Promise<void> {
      const recentJobs = await db
        .select({ id: jobs.id })
        .from(jobs)
        .where(
          and(
            eq(jobs.organizationId, organizationId),
            eq(jobs.databaseId, databaseId),
            inArray(jobs.status, ["pass", "fail", "error"])
          )
        )
        .orderBy(desc(jobs.finishedAt))
        .limit(5);

      for (const row of recentJobs) {
        try {
          const detail = await jobsService.getById(organizationId, row.id);
          await this.syncFromJob(organizationId, detail);
        } catch {
          // skip individual backfill failures
        }
      }
    },
  };
}

function inferCleanupStatus(job: JobDetailResource): string | null {
  const cleanup = job.results.find((r) => r.checkType === "cleanup");
  if (cleanup) {
    if (cleanup.status === "pass") return "completed";
    if (cleanup.status === "fail") return "failed";
    return cleanup.message?.includes("retained") ? "retained" : "skipped";
  }
  const reap = job.results.find((r) => r.checkType === "reap");
  if (!reap) return null;
  return reap.status === "pass" ? "completed" : reap.status === "skip" ? "skipped" : "failed";
}

function parseTemporaryInstanceIdentifier(job: JobDetailResource): string | null {
  const message = job.results.find((result) => result.checkType === "cleanup")?.message;
  return message?.match(/Temporary RDS ([a-z0-9-]+) cleanup/i)?.[1] ?? null;
}

export type RecoveryPointsService = ReturnType<typeof createRecoveryPointsService>;
