import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import type { JobDetailResource, RecoveryReadinessResult } from "@revenant/shared";
import type { Database } from "../db/index.js";
import { databases, evidenceArtifacts, recoveryContracts } from "../db/schema.js";
import { createAppError, isAppError } from "../lib/errors.js";
import { hashRecoveryPayload, signRecoveryPayload } from "../lib/recovery-signing.js";
import { createRecoveryReadinessService } from "./recovery-readiness.service.js";

export interface RecoveryPassportDocument {
  kind: "recovery_passport";
  version: "1";
  system: string;
  databaseId: string;
  jobId: string;
  verifiedAt: string;
  recoveryPoint: string | null;
  contractVersion: number;
  readinessScore: number;
  readinessStatus: string;
  rto: {
    targetSeconds: number | null;
    actualSeconds: number | null;
    pass: boolean;
  };
  rpo: {
    targetSeconds: number | null;
    observedSeconds: number | null;
    pass: boolean;
  };
  dimensions: RecoveryReadinessResult["dimensions"];
  risks: RecoveryReadinessResult["risks"];
  result: "VERIFIED" | "NOT_VERIFIED";
  integrity: {
    algorithm: "sha256";
    hash: string;
    signature: string;
    signedAt: string;
  };
}

export function createRecoveryPassportService(
  db: Database,
  evidenceDir: string,
  masterKey: string
) {
  const readinessService = createRecoveryReadinessService(db);

  return {
    async generateFromJob(
      organizationId: string,
      job: JobDetailResource
    ): Promise<RecoveryPassportDocument | null> {
      if (job.status !== "pass") return null;

      const existing = await db
        .select({ id: evidenceArtifacts.id })
        .from(evidenceArtifacts)
        .where(and(eq(evidenceArtifacts.jobId, job.id), eq(evidenceArtifacts.kind, "passport")))
        .limit(1);

      if (existing[0]) {
        return JSON.parse(
          await this.readBody(organizationId, existing[0].id)
        ) as RecoveryPassportDocument;
      }

      const [dbRow] = await db
        .select()
        .from(databases)
        .where(eq(databases.id, job.databaseId))
        .limit(1);

      const [contractRow] = await db
        .select()
        .from(recoveryContracts)
        .where(eq(recoveryContracts.databaseId, job.databaseId))
        .limit(1);

      const readiness = (
        await readinessService.getForDatabase(organizationId, job.databaseId)
      ).readiness;

      const rtoPass =
        readiness.rtoTargetSeconds != null &&
        readiness.rtoActualSeconds != null &&
        readiness.rtoActualSeconds <= readiness.rtoTargetSeconds;

      const rpoPass =
        readiness.rpoTargetSeconds != null &&
        readiness.rpoObservedSeconds != null &&
        readiness.rpoObservedSeconds <= readiness.rpoTargetSeconds;

      const bodyWithoutIntegrity: Omit<RecoveryPassportDocument, "integrity"> = {
        kind: "recovery_passport",
        version: "1",
        system: dbRow?.name ?? job.databaseName,
        databaseId: job.databaseId,
        jobId: job.id,
        verifiedAt: job.finishedAt ?? new Date().toISOString(),
        recoveryPoint: job.trigger === "full-drill" ? "latest-snapshot" : "direct-verify",
        contractVersion: contractRow?.version ?? 0,
        readinessScore: readiness.score,
        readinessStatus: readiness.status,
        rto: {
          targetSeconds: readiness.rtoTargetSeconds,
          actualSeconds: readiness.rtoActualSeconds,
          pass: rtoPass,
        },
        rpo: {
          targetSeconds: readiness.rpoTargetSeconds,
          observedSeconds: readiness.rpoObservedSeconds,
          pass: rpoPass,
        },
        dimensions: readiness.dimensions,
        risks: readiness.risks,
        result:
          readiness.status === "recovery_ready" && rtoPass ? "VERIFIED" : "NOT_VERIFIED",
      };

      const canonical = JSON.stringify(bodyWithoutIntegrity, null, 2);
      const hash = hashRecoveryPayload(canonical);
      const signature = signRecoveryPayload(canonical, masterKey);

      const passport: RecoveryPassportDocument = {
        ...bodyWithoutIntegrity,
        integrity: {
          algorithm: "sha256",
          hash,
          signature,
          signedAt: new Date().toISOString(),
        },
      };

      const payload = JSON.stringify(passport, null, 2);
      const fileSha256 = createHash("sha256").update(payload).digest("hex");
      const relKey = path.join(organizationId, `${job.id}-passport.json`);
      const absPath = path.join(evidenceDir, relKey);

      await mkdir(path.dirname(absPath), { recursive: true });
      await writeFile(absPath, payload, "utf8");

      await db.insert(evidenceArtifacts).values({
        organizationId,
        jobId: job.id,
        kind: "passport",
        storageKey: relKey,
        sha256: fileSha256,
        byteSize: Buffer.byteLength(payload),
      });

      return passport;
    },

    async ensureForJob(
      organizationId: string,
      job: JobDetailResource
    ): Promise<typeof evidenceArtifacts.$inferSelect> {
      if (job.status !== "pass") {
        throw createAppError(
          404,
          "Recovery passport is available only for successful drills",
          "NOT_READY"
        );
      }

      try {
        return await this.getByJobId(organizationId, job.id);
      } catch (err) {
        if (!isAppError(err) || err.code !== "NOT_FOUND") {
          throw err;
        }
      }

      const generated = await this.generateFromJob(organizationId, job);
      if (generated) {
        try {
          return await this.getByJobId(organizationId, job.id);
        } catch {
          // File write may have failed after insert — fall through to regenerate body below.
        }
      }

      try {
        return await this.getByJobId(organizationId, job.id);
      } catch (err) {
        if (!isAppError(err) || err.code !== "NOT_FOUND") {
          throw err;
        }
        throw createAppError(
          503,
          "Recovery passport could not be generated. Ensure database migration 0016_recovery_readiness is applied.",
          "PASSPORT_UNAVAILABLE"
        );
      }
    },

    /** Returns passport JSON — regenerates on demand if the artifact file is missing. */
    async getPassportBody(organizationId: string, job: JobDetailResource): Promise<string> {
      if (job.status !== "pass") {
        throw createAppError(
          404,
          "Recovery passport is available only for successful drills",
          "NOT_READY"
        );
      }

      try {
        const artifact = await this.ensureForJob(organizationId, job);
        return await this.readBody(organizationId, artifact.id);
      } catch (err) {
        if (!isAppError(err) || err.code !== "NOT_FOUND") {
          throw err;
        }
      }

      const doc = await this.generateFromJob(organizationId, job);
      if (doc) {
        return JSON.stringify(doc, null, 2);
      }

      throw createAppError(404, "Recovery passport not found", "NOT_FOUND");
    },

    async getByJobId(organizationId: string, jobId: string) {
      const [row] = await db
        .select()
        .from(evidenceArtifacts)
        .where(
          and(
            eq(evidenceArtifacts.jobId, jobId),
            eq(evidenceArtifacts.organizationId, organizationId),
            eq(evidenceArtifacts.kind, "passport")
          )
        )
        .limit(1);

      if (!row) {
        throw createAppError(404, "Recovery passport not found", "NOT_FOUND");
      }

      return row;
    },

    async readBody(organizationId: string, artifactId: string): Promise<string> {
      const [row] = await db
        .select()
        .from(evidenceArtifacts)
        .where(
          and(
            eq(evidenceArtifacts.id, artifactId),
            eq(evidenceArtifacts.organizationId, organizationId)
          )
        )
        .limit(1);

      if (!row) {
        throw createAppError(404, "Passport not found", "NOT_FOUND");
      }

      const { readFile } = await import("node:fs/promises");
      const absPath = path.join(evidenceDir, row.storageKey);
      try {
        return await readFile(absPath, "utf8");
      } catch {
        await db
          .delete(evidenceArtifacts)
          .where(
            and(
              eq(evidenceArtifacts.id, row.id),
              eq(evidenceArtifacts.organizationId, organizationId)
            )
          );
        throw createAppError(404, "Recovery passport file missing — retry download", "NOT_FOUND");
      }
    },
  };
}

export type RecoveryPassportService = ReturnType<typeof createRecoveryPassportService>;
