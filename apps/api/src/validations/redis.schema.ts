import { z } from "zod";

/**
 * Redis request schemas.
 *
 * The URL is validated for SHAPE only — we never assert that a Redis URL
 * "looks right" beyond the scheme and host, because customer Redis URLs carry
 * all sorts of legitimate variety (IPv6 literals, db 15, ACL usernames).
 */

const redisUrlSchema = z
  .string()
  .trim()
  .min(1, "Redis URL is required")
  .max(2048, "Redis URL is too long")
  .refine(
    (v) => v.startsWith("redis://") || v.startsWith("rediss://"),
    "Redis URL must start with redis:// or rediss://"
  );

export const createRedisResourceSchema = z.object({
  name: z.string().trim().min(1).max(255),
  url: redisUrlSchema,
  /** Optional link to the Postgres workflow this cache belongs to */
  databaseId: z.string().uuid().nullish(),
  /**
   * Opt-in. When true, RDB artifacts are stored with a mandatory TTL.
   * The API clamps snapshotRetentionHours down to the plan ceiling — a
   * larger request is never honoured, only capped.
   */
  snapshotEnabled: z.boolean().default(false),
  snapshotRetentionHours: z.number().int().positive().max(24 * 365).nullish(),
});

export const updateRedisResourceSchema = z
  .object({
    name: z.string().trim().min(1).max(255).optional(),
    url: redisUrlSchema.optional(),
    databaseId: z.string().uuid().nullish(),
    snapshotEnabled: z.boolean().optional(),
    snapshotRetentionHours: z.number().int().positive().max(24 * 365).nullish(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "At least one field is required",
  });

export const redisIdParamSchema = z.object({ id: z.string().uuid() });
export const redisSnapshotIdParamSchema = z.object({ id: z.string().uuid() });

/** Body for POST /redis/test — a URL that is NOT yet saved. */
export const testRedisUrlSchema = z.object({
  url: redisUrlSchema,
});

/** Body for POST /redis/:id/proofs — start a restore proof. */
export const startRedisProofSchema = z.object({
  /**
   * Optional per-run TTL override in hours. Clamped to the plan ceiling by
   * the service. Omit to use the resource's configured retention.
   */
  retentionHours: z.number().int().positive().max(24 * 365).optional(),
});

export type CreateRedisResourceBody = z.infer<typeof createRedisResourceSchema>;
export type UpdateRedisResourceBody = z.infer<typeof updateRedisResourceSchema>;
export type TestRedisUrlBody = z.infer<typeof testRedisUrlSchema>;
export type StartRedisProofBody = z.infer<typeof startRedisProofSchema>;