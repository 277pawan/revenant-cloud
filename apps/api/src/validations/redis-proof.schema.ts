import { z } from "zod";

/**
 * Redis proof payloads exchanged with the agent.
 *
 * These are runner-token endpoints, not user endpoints — they are the only
 * place a decrypted Redis URL or an RDB payload ever crosses the wire.
 */

export const completeRedisProofSchema = z.object({
  restored: z.boolean(),
  sourceKeyCount: z.number().int().nonnegative().nullable().default(null),
  restoredKeyCount: z.number().int().nonnegative().nullable().default(null),
  rdbBytes: z.number().int().nonnegative().nullable().default(null),
  restoreSeconds: z.number().int().nonnegative().nullable().default(null),
  rpoObservedSeconds: z.number().int().nonnegative().nullable().default(null),
  rdbLastBgsaveStatus: z.string().max(50).nullable().default(null),

  /**
   * Fingerprint from the agent. Digests only — the agent computes these
   * server-side inside the sandbox, so no raw key or value is ever included.
   */
  metadata: z
    .object({
      source: z.enum(["live", "restored_rdb"]),
      version: z.string().nullable().default(null),
      mode: z.string().nullable().default(null),
      keyspace: z.record(
        z.object({
          keys: z.number().int().nonnegative(),
          expires: z.number().int().nonnegative(),
          avgTtl: z.number().nullable().default(null),
        })
      ),
      totalKeys: z.number().int().nonnegative(),
      totalExpires: z.number().int().nonnegative(),
      usedMemoryBytes: z.number().nullable().default(null),
      maxmemoryBytes: z.number().nullable().default(null),
      maxmemoryPolicy: z.string().nullable().default(null),
      requirepass: z.enum(["SET", "NOT SET"]),
      appendOnly: z.enum(["yes", "no"]).nullable().default(null),
      savePolicy: z.string().nullable().default(null),
      sampleDigest: z.string().nullable().default(null),
      sampledKeys: z.number().int().nonnegative(),
      capturedAt: z.string(),
    })
    .nullable()
    .default(null),

  errorMessage: z.string().max(2000).nullable().default(null),

  /** base64 RDB. Only send when the claim set captureRdb. */
  rdbBase64: z.string().nullable().default(null),
});

export type CompleteRedisProofBody = z.infer<typeof completeRedisProofSchema>;