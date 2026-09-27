import type { JobDetailResource } from "@revenant/shared";
import type { RecoveryDriftService } from "./recovery-drift.service.js";
import type { RecoveryFingerprintService } from "./recovery-fingerprint.service.js";
import type { RecoveryPassportService } from "./recovery-passport.service.js";
import type { createReadinessSnapshotService } from "./readiness-snapshot.service.js";
import type { RecoveryPointsService } from "./recovery-points.service.js";
import { jobs, recoveryChallenges } from "../db/schema.js";
import { eq } from "drizzle-orm";
import type { Database } from "../db/index.js";

/** Runs fingerprint, drift, and passport generation after a job completes. */
export type RecoveryPostProcessService = ReturnType<typeof createRecoveryPostProcessService>;

export function createRecoveryPostProcessService(
  db: Database,
  deps: {
    fingerprintService: RecoveryFingerprintService;
    driftService: RecoveryDriftService;
    passportService: RecoveryPassportService;
    snapshotService: ReturnType<typeof createReadinessSnapshotService>;
    recoveryPointsService: RecoveryPointsService;
  }
) {
  return {
    async onJobCompleted(organizationId: string, job: JobDetailResource): Promise<void> {
      try {
        await deps.recoveryPointsService.syncFromJob(organizationId, job);
      } catch (err) {
        console.error("[recovery] recovery point sync failed:", err);
      }
      if (job.status === "pass") {
        try {
          await deps.snapshotService.recordFromJob(organizationId, job);
        } catch (err) {
          console.error("[recovery] readiness snapshot failed:", err);
        }
      }

      try {
        const [jobRow] = await db
          .select({ metadataJson: jobs.metadataJson })
          .from(jobs)
          .where(eq(jobs.id, job.id))
          .limit(1);
        const challengeId = (jobRow?.metadataJson as { challengeId?: string } | null)
          ?.challengeId;
        if (challengeId) {
          await db
            .update(recoveryChallenges)
            .set({ lastStatus: job.status, updatedAt: new Date() })
            .where(eq(recoveryChallenges.id, challengeId));
        }
      } catch {
        // non-fatal
      }

      if (job.status !== "pass") return;

      try {
        const fingerprintId = await deps.fingerprintService.recordFromJob(
          organizationId,
          job
        );

        if (fingerprintId) {
          await deps.driftService.resolveOpenOnVerification(
            organizationId,
            job.databaseId,
            fingerprintId
          );
          await deps.driftService.detectAfterFingerprint(
            organizationId,
            job.databaseId,
            fingerprintId
          );
        }
      } catch (err) {
        console.error("[recovery] fingerprint/drift step failed (job still saved):", err);
      }

      try {
        await deps.passportService.generateFromJob(organizationId, job);
      } catch (err) {
        console.error("[recovery] passport generation failed (job still saved):", err);
      }
    },
  };
}
