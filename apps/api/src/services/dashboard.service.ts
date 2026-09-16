import { and, count, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type {
  DashboardFleetRow,
  DashboardOnboardingStep,
  DashboardOverview,
  DashboardRtoTrend,
  DashboardRtoTrendPoint,
  FleetHealthStatus,
  OrganizationPlan,
} from "@revenant/shared";
import type { Database } from "../db/index.js";
import {
  databaseAwsCredentials,
  databaseCredentials,
  databases,
  evidenceArtifacts,
  jobs,
  organizations,
  runners,
  schedules,
  validationPlans,
  webhookEndpoints,
} from "../db/schema.js";

function computeHealth(input: {
  hasPlan: boolean;
  hasCredentials: boolean;
  recoveryMode: string;
  hasAws: boolean;
  lastStatus: string | null;
  lastFinishedAt: Date | null;
  agentOnline: boolean;
  hasSchedule: boolean;
}): { health: FleetHealthStatus; reason: string } {
  if (!input.hasPlan || !input.hasCredentials) {
    return {
      health: "critical",
      reason: !input.hasPlan ? "No validation plan" : "Missing database credentials",
    };
  }
  if (input.recoveryMode === "aws-rds" && !input.hasAws) {
    return { health: "critical", reason: "AWS restore mode — keys not configured" };
  }
  if (!input.lastStatus) {
    return { health: "unknown", reason: "No restore drill run yet" };
  }
  if (input.lastStatus === "fail" || input.lastStatus === "error") {
    return { health: "critical", reason: "Last drill failed" };
  }
  if (input.lastFinishedAt) {
    const daysSince =
      (Date.now() - input.lastFinishedAt.getTime()) / (1000 * 60 * 60 * 24);
    if (daysSince > 7) {
      return { health: "warning", reason: "Last successful drill over 7 days ago" };
    }
  }
  if (!input.agentOnline) {
    return { health: "warning", reason: "Agent not seen recently" };
  }
  if (!input.hasSchedule) {
    return { health: "warning", reason: "No schedule — drills are manual only" };
  }
  return { health: "healthy", reason: "Last drill passed" };
}

export function createDashboardService(db: Database) {
  return {
    async getOverview(organizationId: string): Promise<DashboardOverview> {
      const now = new Date();
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

      const [orgRow] = await db
        .select({ plan: organizations.plan })
        .from(organizations)
        .where(eq(organizations.id, organizationId))
        .limit(1);

      const orgPlan = (orgRow?.plan ?? "starter") as OrganizationPlan;

      const dbRows = await db
        .select({
          db: databases,
          hasCredentials: sql<boolean>`(${databaseCredentials.id} is not null)`,
          hasAws: sql<boolean>`(${databaseAwsCredentials.id} is not null)`,
          planId: validationPlans.id,
        })
        .from(databases)
        .leftJoin(databaseCredentials, eq(databaseCredentials.databaseId, databases.id))
        .leftJoin(
          databaseAwsCredentials,
          eq(databaseAwsCredentials.databaseId, databases.id)
        )
        .leftJoin(validationPlans, eq(validationPlans.databaseId, databases.id))
        .where(eq(databases.organizationId, organizationId));

      const databaseIds = dbRows.map((r) => r.db.id);

      const [
        recentJobs,
        jobStats7d,
        failures24hRow,
        evidenceCountRow,
        scheduleRows,
        runnerRows,
        webhookCountRow,
        completedJobCountRow,
      ] = await Promise.all([
        databaseIds.length
          ? db
              .select()
              .from(jobs)
              .where(
                and(
                  eq(jobs.organizationId, organizationId),
                  inArray(jobs.databaseId, databaseIds)
                )
              )
              .orderBy(desc(jobs.createdAt))
          : Promise.resolve([]),
        db
          .select({
            status: jobs.status,
            rtoSeconds: jobs.rtoSeconds,
          })
          .from(jobs)
          .where(
            and(
              eq(jobs.organizationId, organizationId),
              gte(jobs.finishedAt, sevenDaysAgo),
              inArray(jobs.status, ["pass", "fail", "error"])
            )
          ),
        db
          .select({ value: count() })
          .from(jobs)
          .where(
            and(
              eq(jobs.organizationId, organizationId),
              gte(jobs.finishedAt, oneDayAgo),
              inArray(jobs.status, ["fail", "error"])
            )
          ),
        db
          .select({ value: count() })
          .from(evidenceArtifacts)
          .where(eq(evidenceArtifacts.organizationId, organizationId)),
        db
          .select()
          .from(schedules)
          .where(eq(schedules.organizationId, organizationId)),
        db
          .select()
          .from(runners)
          .where(eq(runners.organizationId, organizationId)),
        db
          .select({ value: count() })
          .from(webhookEndpoints)
          .where(eq(webhookEndpoints.organizationId, organizationId)),
        db
          .select({ value: count() })
          .from(jobs)
          .where(
            and(
              eq(jobs.organizationId, organizationId),
              inArray(jobs.status, ["pass", "fail", "error"])
            )
          ),
      ]);

      const lastJobByDb = new Map<string, (typeof recentJobs)[0]>();
      for (const job of recentJobs) {
        if (!lastJobByDb.has(job.databaseId)) {
          lastJobByDb.set(job.databaseId, job);
        }
      }

      const scheduleByDb = new Map(scheduleRows.map((s) => [s.databaseId, s]));
      const runnerByDb = new Map(
        runnerRows
          .filter((r) => r.databaseId)
          .map((r) => [r.databaseId!, r])
      );

      const fleet: DashboardFleetRow[] = dbRows.map((row) => {
        const lastJob = lastJobByDb.get(row.db.id);
        const schedule = scheduleByDb.get(row.db.id);
        const runner = runnerByDb.get(row.db.id);
        const agentLastSeen = runner?.lastSeenAt ?? null;
        const agentOnline =
          agentLastSeen != null &&
          now.getTime() - agentLastSeen.getTime() < 60_000;

        const { health, reason } = computeHealth({
          hasPlan: row.planId != null,
          hasCredentials: Boolean(row.hasCredentials),
          recoveryMode: row.db.recoveryMode ?? "direct",
          hasAws: Boolean(row.hasAws),
          lastStatus: lastJob?.status ?? null,
          lastFinishedAt: lastJob?.finishedAt ?? null,
          agentOnline,
          hasSchedule: schedule != null,
        });

        return {
          databaseId: row.db.id,
          databaseName: row.db.name,
          recoveryMode: row.db.recoveryMode === "aws-rds" ? "aws-rds" : "direct",
          health,
          healthReason: reason,
          lastJobId: lastJob?.id ?? null,
          lastJobStatus: lastJob?.status ?? null,
          lastJobFinishedAt: lastJob?.finishedAt?.toISOString() ?? null,
          lastRtoSeconds: lastJob?.rtoSeconds ?? null,
          hasValidationPlan: row.planId != null,
          hasCredentials: Boolean(row.hasCredentials),
          hasAwsCredentials: Boolean(row.hasAws),
          hasSchedule: schedule != null,
          scheduleEnabled: schedule?.enabled === "true",
          nextRunAt: schedule?.nextRunAt?.toISOString() ?? null,
          agentLastSeenAt: agentLastSeen?.toISOString() ?? null,
          agentOnline,
        };
      });

      const finished7d = jobStats7d.filter((j) =>
        ["pass", "fail", "error"].includes(j.status)
      );
      const passed7d = finished7d.filter((j) => j.status === "pass");
      const passRate7d =
        finished7d.length > 0
          ? Math.round((passed7d.length / finished7d.length) * 100)
          : null;
      const rtoValues = passed7d
        .map((j) => j.rtoSeconds)
        .filter((v): v is number => v != null);
      const avgRtoSeconds7d =
        rtoValues.length > 0
          ? Math.round(rtoValues.reduce((a, b) => a + b, 0) / rtoValues.length)
          : null;

      const healthCounts = { healthy: 0, warning: 0, critical: 0, unknown: 0 };
      for (const f of fleet) {
        healthCounts[f.health]++;
      }

      const agentsOnline = runnerRows.filter(
        (r) =>
          r.lastSeenAt && now.getTime() - r.lastSeenAt.getTime() < 60_000
      ).length;

      const hasDatabase = dbRows.length > 0;
      const hasPlan = dbRows.some((r) => r.planId != null);
      const hasRunner = runnerRows.length > 0;
      const hasCompletedJob = Number(completedJobCountRow[0]?.value ?? 0) > 0;
      const hasSchedule = scheduleRows.length > 0;
      const hasIntegration = Number(webhookCountRow[0]?.value ?? 0) > 0;

      const onboarding: DashboardOnboardingStep[] = [
        {
          id: "database",
          label: "Register a database workflow",
          done: hasDatabase,
          href: "/databases/new",
        },
        {
          id: "plan",
          label: "Save a validation plan (or import AWS free-tier template)",
          done: hasPlan,
          href: "/settings/validation-plans",
        },
        {
          id: "aws",
          label: "Add AWS keys for managed sandbox drills (RDS snapshot → verify)",
          done: dbRows.some((r) => r.db.recoveryMode === "aws-rds" && r.hasAws),
          href: "/databases/new",
        },
        {
          id: "drill",
          label: "Run your first managed restore drill (no Docker agent)",
          done: hasCompletedJob,
          href: "/workflows",
        },
        {
          id: "agent",
          label: "Optional: private-network agent (Pro / direct Postgres)",
          done: hasRunner,
          href: "/settings/runners",
        },
        {
          id: "schedule",
          label: "Schedule automatic drills",
          done: hasSchedule,
          href: "/schedules",
        },
        {
          id: "alert",
          label: "Add Slack or email alerts",
          done: hasIntegration,
          href: "/settings/webhooks",
        },
      ];

      return {
        organizationPlan: orgPlan,
        summary: {
          totalDatabases: fleet.length,
          healthyCount: healthCounts.healthy,
          warningCount: healthCounts.warning,
          criticalCount: healthCounts.critical,
          passRate7d,
          avgRtoSeconds7d,
          failures24h: Number(failures24hRow[0]?.value ?? 0),
          evidenceCount: Number(evidenceCountRow[0]?.value ?? 0),
          agentsOnline,
        },
        onboarding,
        fleet,
      };
    },

    async getRtoTrends(organizationId: string): Promise<DashboardRtoTrend> {
      const now = new Date();
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

      const rows = await db
        .select({
          day: sql<string>`to_char(date_trunc('day', ${jobs.finishedAt} at time zone 'UTC'), 'YYYY-MM-DD')`,
          avgRto: sql<number | null>`round(avg(${jobs.rtoSeconds}))::int`,
          passCount: sql<number>`count(*)::int`,
        })
        .from(jobs)
        .where(
          and(
            eq(jobs.organizationId, organizationId),
            eq(jobs.status, "pass"),
            gte(jobs.finishedAt, thirtyDaysAgo),
            sql`${jobs.rtoSeconds} is not null`
          )
        )
        .groupBy(sql`date_trunc('day', ${jobs.finishedAt} at time zone 'UTC')`)
        .orderBy(sql`date_trunc('day', ${jobs.finishedAt} at time zone 'UTC')`);

      const byDay = new Map(
        rows.map((r) => [
          r.day,
          {
            date: r.day,
            avgRtoSeconds:
              r.avgRto != null ? Number(r.avgRto) : null,
            passCount: Number(r.passCount ?? 0),
          } satisfies DashboardRtoTrendPoint,
        ])
      );

      const days: DashboardRtoTrendPoint[] = [];
      for (let i = 29; i >= 0; i--) {
        const d = new Date(now);
        d.setUTCDate(d.getUTCDate() - i);
        const key = d.toISOString().slice(0, 10);
        days.push(
          byDay.get(key) ?? {
            date: key,
            avgRtoSeconds: null,
            passCount: 0,
          }
        );
      }

      return { days };
    },
  };
}

export type DashboardService = ReturnType<typeof createDashboardService>;
