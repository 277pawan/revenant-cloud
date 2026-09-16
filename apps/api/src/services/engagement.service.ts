import { eq, sql, desc, gte } from "drizzle-orm";
import type { Database } from "../db/index.js";
import {
  siteEngagementEvents,
  siteTrafficCounters,
} from "../db/schema.js";
import type { EngagementTrackInput } from "../validations/engagement.schema.js";

async function bumpCounter(
  db: Database,
  site: "marketing" | "app",
  eventType: EngagementTrackInput["eventType"]
) {
  const column =
    eventType === "visit" || eventType === "page_view"
      ? "total_visits"
      : eventType === "hero_view"
        ? "total_hero_views"
        : eventType === "login"
          ? "total_logins"
          : eventType === "register"
            ? "total_registers"
            : null;

  if (!column) return;

  await db
    .insert(siteTrafficCounters)
    .values({
      site,
      totalVisits: eventType === "visit" || eventType === "page_view" ? 1 : 0,
      totalHeroViews: eventType === "hero_view" ? 1 : 0,
      totalLogins: eventType === "login" ? 1 : 0,
      totalRegisters: eventType === "register" ? 1 : 0,
    })
    .onConflictDoUpdate({
      target: siteTrafficCounters.site,
      set: {
        ...(column === "total_visits"
          ? { totalVisits: sql`${siteTrafficCounters.totalVisits} + 1` }
          : {}),
        ...(column === "total_hero_views"
          ? { totalHeroViews: sql`${siteTrafficCounters.totalHeroViews} + 1` }
          : {}),
        ...(column === "total_logins"
          ? { totalLogins: sql`${siteTrafficCounters.totalLogins} + 1` }
          : {}),
        ...(column === "total_registers"
          ? { totalRegisters: sql`${siteTrafficCounters.totalRegisters} + 1` }
          : {}),
        updatedAt: new Date(),
      },
    });
}

export function createEngagementService(db: Database) {
  return {
    async track(input: EngagementTrackInput) {
      const [row] = await db
        .insert(siteEngagementEvents)
        .values({
          site: input.site,
          eventType: input.eventType,
          path: input.path ?? null,
          visitorId: input.visitorId,
          userId: input.userId ?? null,
          userEmail: input.userEmail?.toLowerCase() ?? null,
          visibility: input.visibility,
          meta: input.meta ?? null,
        })
        .returning({ id: siteEngagementEvents.id });

      await bumpCounter(db, input.site, input.eventType);

      return { ok: true as const, id: row!.id };
    },

    async stats() {
      const counters = await db.select().from(siteTrafficCounters);

      const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const recent = await db
        .select()
        .from(siteEngagementEvents)
        .where(gte(siteEngagementEvents.createdAt, since))
        .orderBy(desc(siteEngagementEvents.createdAt))
        .limit(50);

      const uniqueMarketing = await db
        .select({
          count: sql<number>`count(distinct ${siteEngagementEvents.visitorId})`,
        })
        .from(siteEngagementEvents)
        .where(eq(siteEngagementEvents.site, "marketing"));

      const uniqueApp = await db
        .select({
          count: sql<number>`count(distinct ${siteEngagementEvents.visitorId})`,
        })
        .from(siteEngagementEvents)
        .where(eq(siteEngagementEvents.site, "app"));

      const bySite = Object.fromEntries(
        counters.map((c) => [
          c.site,
          {
            site: c.site,
            totalVisits: c.totalVisits,
            totalHeroViews: c.totalHeroViews,
            totalLogins: c.totalLogins,
            totalRegisters: c.totalRegisters,
            updatedAt: c.updatedAt.toISOString(),
          },
        ])
      );

      return {
        counters: {
          marketing: bySite.marketing ?? {
            site: "marketing",
            totalVisits: 0,
            totalHeroViews: 0,
            totalLogins: 0,
            totalRegisters: 0,
            updatedAt: null,
          },
          app: bySite.app ?? {
            site: "app",
            totalVisits: 0,
            totalHeroViews: 0,
            totalLogins: 0,
            totalRegisters: 0,
            updatedAt: null,
          },
        },
        uniqueVisitors: {
          marketing: Number(uniqueMarketing[0]?.count ?? 0),
          app: Number(uniqueApp[0]?.count ?? 0),
        },
        recentEvents: recent.map((e) => ({
          id: e.id,
          site: e.site,
          eventType: e.eventType,
          path: e.path,
          visitorId: e.visitorId,
          userId: e.userId,
          userEmail: e.userEmail,
          visibility: e.visibility,
          createdAt: e.createdAt.toISOString(),
        })),
      };
    },

    async publicCounters(site: "marketing" | "app") {
      const [row] = await db
        .select()
        .from(siteTrafficCounters)
        .where(eq(siteTrafficCounters.site, site))
        .limit(1);
      return {
        site,
        totalVisits: row?.totalVisits ?? 0,
        totalHeroViews: row?.totalHeroViews ?? 0,
      };
    },
  };
}

export type EngagementService = ReturnType<typeof createEngagementService>;
