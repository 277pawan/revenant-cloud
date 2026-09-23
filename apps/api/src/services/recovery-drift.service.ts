import { and, desc, eq } from "drizzle-orm";
import type { DriftSeverity } from "@revenant/shared";
import type { Database } from "../db/index.js";
import {
  recoveryDriftEvents,
  recoveryFingerprints,
  validationPlans,
} from "../db/schema.js";

export interface DriftEventResource {
  id: string;
  severity: DriftSeverity;
  changeType: string;
  description: string;
  status: string;
  createdAt: string;
}

export function createRecoveryDriftService(db: Database) {
  return {
    async listOpen(
      organizationId: string,
      databaseId: string
    ): Promise<DriftEventResource[]> {
      const rows = await db
        .select()
        .from(recoveryDriftEvents)
        .where(
          and(
            eq(recoveryDriftEvents.databaseId, databaseId),
            eq(recoveryDriftEvents.organizationId, organizationId),
            eq(recoveryDriftEvents.status, "open")
          )
        )
        .orderBy(desc(recoveryDriftEvents.createdAt))
        .limit(20);

      return rows.map((r) => ({
        id: r.id,
        severity: r.severity as DriftSeverity,
        changeType: r.changeType,
        description: r.description,
        status: r.status,
        createdAt: r.createdAt.toISOString(),
      }));
    },

    async detectAfterFingerprint(
      organizationId: string,
      databaseId: string,
      newFingerprintId: string
    ): Promise<void> {
      const fingerprints = await db
        .select()
        .from(recoveryFingerprints)
        .where(eq(recoveryFingerprints.databaseId, databaseId))
        .orderBy(desc(recoveryFingerprints.createdAt))
        .limit(2);

      const [planRow] = await db
        .select()
        .from(validationPlans)
        .where(eq(validationPlans.databaseId, databaseId))
        .limit(1);

      const previous = fingerprints.find((f) => f.id !== newFingerprintId);
      const current = fingerprints.find((f) => f.id === newFingerprintId);
      if (!previous || !current) return;

      const prevPayload = previous.fingerprintJson as {
        validationPlanVersion?: number;
        database?: { schemaHash?: string };
      };
      const currPayload = current.fingerprintJson as {
        validationPlanVersion?: number;
        database?: { schemaHash?: string };
      };

      const events: Array<{
        severity: DriftSeverity;
        changeType: string;
        description: string;
      }> = [];

      if (
        prevPayload.database?.schemaHash &&
        currPayload.database?.schemaHash &&
        prevPayload.database.schemaHash !== currPayload.database.schemaHash
      ) {
        events.push({
          severity: "minor_drift",
          changeType: "schema_change",
          description: "Schema validation fingerprint changed since last verified recovery",
        });
      }

      if (
        prevPayload.validationPlanVersion != null &&
        currPayload.validationPlanVersion != null &&
        prevPayload.validationPlanVersion !== currPayload.validationPlanVersion
      ) {
        events.push({
          severity: "minor_drift",
          changeType: "plan_change",
          description: `Validation plan changed v${prevPayload.validationPlanVersion} → v${currPayload.validationPlanVersion} since last verified recovery`,
        });
      }

      for (const event of events) {
        await db.insert(recoveryDriftEvents).values({
          organizationId,
          databaseId,
          fromFingerprintId: previous.id,
          toFingerprintId: current.id,
          severity: event.severity,
          changeType: event.changeType,
          description: event.description,
          status: "open",
        });
      }
    },

    async recordPlanDriftOnUpdate(
      organizationId: string,
      databaseId: string,
      newPlanVersion: number
    ): Promise<void> {
      const [latest] = await db
        .select()
        .from(recoveryFingerprints)
        .where(eq(recoveryFingerprints.databaseId, databaseId))
        .orderBy(desc(recoveryFingerprints.createdAt))
        .limit(1);

      if (!latest) return;

      const fp = latest.fingerprintJson as { validationPlanVersion?: number };
      if (fp.validationPlanVersion === newPlanVersion) return;

      await db.insert(recoveryDriftEvents).values({
        organizationId,
        databaseId,
        fromFingerprintId: latest.id,
        severity: "minor_drift",
        changeType: "plan_change",
        description: `Validation plan updated to v${newPlanVersion} — re-verify recovery`,
        status: "open",
      });
    },

    /** Close open drift after a successful drill establishes a new verified baseline. */
    async resolveOpenOnVerification(
      organizationId: string,
      databaseId: string,
      fingerprintId: string
    ): Promise<number> {
      const resolved = await db
        .update(recoveryDriftEvents)
        .set({ status: "resolved", toFingerprintId: fingerprintId })
        .where(
          and(
            eq(recoveryDriftEvents.organizationId, organizationId),
            eq(recoveryDriftEvents.databaseId, databaseId),
            eq(recoveryDriftEvents.status, "open")
          )
        )
        .returning({ id: recoveryDriftEvents.id });

      return resolved.length;
    },
  };
}

export type RecoveryDriftService = ReturnType<typeof createRecoveryDriftService>;
