import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { JobDetailResource } from "@revenant/shared";
import type { Database } from "../db/index.js";
import { jobResults, jobs, readinessSnapshots } from "../db/schema.js";
import { extractRpoObservedSeconds } from "@revenant/shared";
import type { RecoveryReadinessService } from "./recovery-readiness.service.js";

export interface ReadinessHistoryPoint {
  recordedAt: string;
  score: number;
  status: string;
  rtoActualSeconds: number | null;
  rpoObservedSeconds: number | null;
  jobId: string;
}

export function createReadinessSnapshotService(
  db: Database,
  readinessService: RecoveryReadinessService
) {
  return {
    async recordFromJob(organizationId: string, job: JobDetailResource): Promise<void> {
      if (job.status !== "pass") return;

      const readiness = (
        await readinessService.getForDatabase(organizationId, job.databaseId)
      ).readiness;

      await db.insert(readinessSnapshots).values({
        organizationId,
        databaseId: job.databaseId,
        jobId: job.id,
        score: readiness.score,
        status: readiness.status,
        rtoActualSeconds: readiness.rtoActualSeconds,
        rpoObservedSeconds: readiness.rpoObservedSeconds,
      });
    },

    async getHistory(
      organizationId: string,
      databaseId: string,
      limit = 30
    ): Promise<ReadinessHistoryPoint[]> {
      const rows = await db
        .select()
        .from(readinessSnapshots)
        .where(
          and(
            eq(readinessSnapshots.organizationId, organizationId),
            eq(readinessSnapshots.databaseId, databaseId)
          )
        )
        .orderBy(desc(readinessSnapshots.recordedAt))
        .limit(limit);

      return rows
        .map((r) => ({
          recordedAt: r.recordedAt.toISOString(),
          score: r.score,
          status: r.status,
          rtoActualSeconds: r.rtoActualSeconds,
          rpoObservedSeconds: r.rpoObservedSeconds,
          jobId: r.jobId,
        }))
        .reverse();
    },

    async getRpoTrends(organizationId: string) {
      const now = new Date();
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

      const rows = await db
        .select({
          day: sql<string>`to_char(date_trunc('day', ${jobs.finishedAt} at time zone 'UTC'), 'YYYY-MM-DD')`,
          jobId: jobs.id,
        })
        .from(jobs)
        .where(
          and(
            eq(jobs.organizationId, organizationId),
            eq(jobs.status, "pass"),
            gte(jobs.finishedAt, thirtyDaysAgo)
          )
        );

      const jobIds = rows.map((r) => r.jobId);
      if (jobIds.length === 0) {
        return { days: buildEmptyDays(now) };
      }

      const results = await db
        .select({
          jobId: jobResults.jobId,
          checkType: jobResults.checkType,
          status: jobResults.status,
          message: jobResults.message,
        })
        .from(jobResults)
        .where(inArray(jobResults.jobId, jobIds));

      const rpoByJob = new Map<string, number>();
      for (const jobId of jobIds) {
        const jobResultsForJob = results.filter((r) => r.jobId === jobId);
        const rpo = extractRpoObservedSeconds(jobResultsForJob);
        if (rpo != null) rpoByJob.set(jobId, rpo);
      }

      const byDay = new Map<string, { maxRpo: number | null; count: number }>();
      for (const row of rows) {
        const rpo = rpoByJob.get(row.jobId);
        if (rpo == null) continue;
        const existing = byDay.get(row.day) ?? { maxRpo: null, count: 0 };
        byDay.set(row.day, {
          maxRpo: existing.maxRpo == null ? rpo : Math.max(existing.maxRpo, rpo),
          count: existing.count + 1,
        });
      }

      const days = buildEmptyDays(now).map((d) => {
        const hit = byDay.get(d.date);
        return hit
          ? { date: d.date, maxRpoSeconds: hit.maxRpo, sampleCount: hit.count }
          : { date: d.date, maxRpoSeconds: null, sampleCount: 0 };
      });

      return { days };
    },
  };
}

function buildEmptyDays(now: Date) {
  const days: { date: string }[] = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    days.push({ date: d.toISOString().slice(0, 10) });
  }
  return days;
}
