import { z } from "zod";

export const engagementTrackSchema = z.object({
  site: z.enum(["marketing", "app"]),
  eventType: z.enum([
    "visit",
    "hero_view",
    "page_view",
    "login",
    "register",
  ]),
  path: z.string().max(2000).optional(),
  visitorId: z.string().min(8).max(64),
  userId: z.string().uuid().optional(),
  userEmail: z.string().email().max(255).optional(),
  visibility: z.enum(["visible", "hidden"]).default("visible"),
  meta: z.record(z.string(), z.unknown()).optional(),
});

export type EngagementTrackInput = z.infer<typeof engagementTrackSchema>;
