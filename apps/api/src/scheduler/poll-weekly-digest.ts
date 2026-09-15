import { and, eq } from "drizzle-orm";
import type { Env } from "../config/env.js";
import type { Database } from "../db/index.js";
import { organizations, users, weeklyDigestLog } from "../db/schema.js";
import {
  weeklyDigestHtml,
  weeklyDigestPlainText,
} from "../lib/notification-templates.js";
import { sendTransactionalMail } from "../lib/transactional-mail.js";
import { createDashboardService } from "../services/dashboard.service.js";

function isoWeekKey(date: Date): string {
  const d = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  );
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function shouldSendWeeklyDigest(now: Date): boolean {
  return now.getUTCDay() === 1 && now.getUTCHours() === 9;
}

export function startWeeklyDigestPoll(options: {
  db: Database;
  env: Env;
  intervalMs?: number;
  label?: string;
}) {
  const { db, env } = options;
  const intervalMs = options.intervalMs ?? 60 * 60 * 1000;
  const label = options.label ?? "digest";
  const dashboard = createDashboardService(db);

  const tick = async () => {
    if (!shouldSendWeeklyDigest(new Date())) return;

    const now = new Date();
    const weekKey = isoWeekKey(now);
    const orgRows = await db
      .select({ id: organizations.id, name: organizations.name })
      .from(organizations);

    for (const org of orgRows) {
      const already = await db
        .select({ organizationId: weeklyDigestLog.organizationId })
        .from(weeklyDigestLog)
        .where(
          and(
            eq(weeklyDigestLog.organizationId, org.id),
            eq(weeklyDigestLog.weekKey, weekKey)
          )
        )
        .limit(1);

      if (already[0]) continue;

      const adminRows = await db
        .select({ email: users.email })
        .from(users)
        .where(and(eq(users.organizationId, org.id), eq(users.role, "admin")));

      const recipients = adminRows.map((r) => r.email).filter(Boolean);
      if (recipients.length === 0) continue;

      const overview = await dashboard.getOverview(org.id);
      const digestInput = {
        orgName: org.name,
        passRate7d: overview.summary.passRate7d,
        avgRtoSeconds7d: overview.summary.avgRtoSeconds7d,
        healthy: overview.summary.healthyCount,
        warning: overview.summary.warningCount,
        critical: overview.summary.criticalCount,
        total: overview.summary.totalDatabases,
        failures24h: overview.summary.failures24h,
        appUrl: env.PUBLIC_APP_URL,
      };

      try {
        await sendTransactionalMail(env, {
          to: recipients,
          subject: `[Revenant] Weekly DR digest — ${org.name}`,
          text: weeklyDigestPlainText(digestInput),
          html: weeklyDigestHtml(digestInput),
        });

        await db.insert(weeklyDigestLog).values({
          organizationId: org.id,
          weekKey,
        });
      } catch (err) {
        console.error(`[${label}] digest failed for org ${org.id}:`, err);
      }
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  return () => clearInterval(timer);
}
