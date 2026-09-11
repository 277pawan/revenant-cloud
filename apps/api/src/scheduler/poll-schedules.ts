import { and, eq, lte } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { schedules } from "../db/schema.js";
import { computeNextRunAt } from "../lib/cron.js";
import type { JobsService } from "../services/jobs.service.js";

export function startSchedulePoll(deps: {
  db: Database;
  jobsService: JobsService;
  intervalMs: number;
  label?: string;
}) {
  const tag = deps.label ?? "scheduler";

  async function tick() {
    const now = new Date();
    const due = await deps.db
      .select()
      .from(schedules)
      .where(
        and(eq(schedules.enabled, "true"), lte(schedules.nextRunAt, now))
      )
      .limit(20);

    for (const row of due) {
      try {
        await deps.jobsService.createFromSchedule(
          row.organizationId,
          row.databaseId
        );

        const nextRunAt = computeNextRunAt(
          row.cronExpression,
          row.timezone,
          now
        );

        await deps.db
          .update(schedules)
          .set({
            lastRunAt: now,
            nextRunAt,
            updatedAt: now,
          })
          .where(eq(schedules.id, row.id));
      } catch (err) {
        console.error(
          `[${tag}] failed schedule ${row.id}:`,
          err instanceof Error ? err.message : err
        );
      }
    }
  }

  void tick();
  const timer = setInterval(() => void tick(), deps.intervalMs);

  return () => clearInterval(timer);
}
