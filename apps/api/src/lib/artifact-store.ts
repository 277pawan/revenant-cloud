/**
 * Artifact store — where Redis RDB bytes live (or don't).
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY THIS IS AN INTERFACE AND NOT A SERVICE CALL
 *
 * We are starting with zero budget, so v1 runs on local disk. That is fine,
 * but it must not leak into the services: the moment `redis-snapshots.service`
 * calls `fs.writeFile`, swapping to object storage becomes a rewrite instead
 * of a config change. Everything goes through `ArtifactStore` instead.
 *
 * WHEN YOU ADD THE REAL BACKEND, PICK THIS CAREFULLY:
 *
 *   Use Cloudflare R2 or Backblaze B2 — NOT Amazon S3 and NOT GCS.
 *
 * Restores are the whole product: every proof pulls the artifact back down.
 * S3 and GCS charge per-GB egress, which for a restore-heavy, proof-heavy
 * product becomes the dominant line item and quietly scales with success.
 * R2 and B2 charge $0 egress. Storage itself is ~$0.015/GB-month, which is
 * noise; egress is what kills you.
 *
 * Both have free tiers (R2: 10 GB, B2: 10 GB) so the migration can happen on
 * a real account without a budget conversation.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * TTL IS ENFORCED IN TWO PLACES, ON PURPOSE
 *
 *   1. This store's `delete` — called by the sweeper on `expires_at`.
 *   2. Bucket lifecycle rules in the real backend — a backstop for when the
 *      API is down or a deploy wipes the sweeper.
 *
 * Never rely on (2) alone. A lifecycle rule that quietly stops existing is
 * exactly how you end up paying for a customer's cache forever.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rm, stat, writeFile, readFile, access } from "node:fs/promises";
import { dirname, join, normalize, sep } from "node:path";
import { gunzipSync, gzipSync, constants } from "node:zlib";
// zstd is accessed OFF the namespace on purpose: a named import of
// `zstdCompressSync` would throw at module load on Node < 22.15, which turns a
// graceful fallback into an API that refuses to boot.
import * as zlib from "node:zlib";

import { createAppError } from "./errors.js";
import { R2ArtifactStore } from "./r2-artifact-store.js";

export interface StoredArtifact {
  key: string;
  byteSize: number;
  checksumSha256: string;
}

export interface ArtifactStore {
  /** Human-readable backend id, recorded on each snapshot row for debugging */
  readonly name: string;
  put(key: string, data: Buffer): Promise<StoredArtifact>;
  get(key: string): Promise<Buffer>;
  exists(key: string): Promise<boolean>;
  /** Idempotent — deleting a missing key is a success, not an error */
  delete(key: string): Promise<void>;
}

/**
 * Reject anything that could escape the artifact root.
 * Keys are generated server-side, but this is the one function where a
 * traversal bug becomes arbitrary file read/write, so it is checked anyway.
 */
export function assertSafeArtifactKey(key: string): void {
  if (!key || key.length > 512) {
    throw createAppError(400, "Invalid artifact key", "INVALID_ARTIFACT_KEY");
  }
  if (key.includes("\0")) {
    throw createAppError(400, "Invalid artifact key", "INVALID_ARTIFACT_KEY");
  }
  const normalized = normalize(key);
  if (normalized.startsWith("..") || normalized.startsWith(sep) || normalized.includes(`..${sep}`)) {
    throw createAppError(400, "Invalid artifact key", "INVALID_ARTIFACT_KEY");
  }
}

/** Local filesystem store — dev and zero-budget self-host. */
export class LocalDiskArtifactStore implements ArtifactStore {
  readonly name = "local-disk";

  constructor(private readonly rootDir: string) {}

  private resolve(key: string): string {
    assertSafeArtifactKey(key);
    const full = join(this.rootDir, key);
    const rootNorm = normalize(this.rootDir);
    if (!normalize(full).startsWith(rootNorm + sep)) {
      throw createAppError(400, "Invalid artifact key", "INVALID_ARTIFACT_KEY");
    }
    return full;
  }

  async put(key: string, data: Buffer): Promise<StoredArtifact> {
    const full = this.resolve(key);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, data);
    return {
      key,
      byteSize: data.byteLength,
      checksumSha256: createHash("sha256").update(data).digest("hex"),
    };
  }

  async get(key: string): Promise<Buffer> {
    const full = this.resolve(key);
    try {
      return await readFile(full);
    } catch {
      throw createAppError(404, "Artifact not found or already expired", "ARTIFACT_NOT_FOUND");
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await access(this.resolve(key));
      return true;
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.resolve(key), { force: true });
  }

  /** Byte size without loading the file — used by the sweeper's reporting */
  async size(key: string): Promise<number | null> {
    try {
      const s = await stat(this.resolve(key));
      return s.size;
    } catch {
      return null;
    }
  }

  stream(key: string) {
    return createReadStream(this.resolve(key));
  }
}

let cached: ArtifactStore | null = null;

/**
 * Build the configured store once per process.
 *
 * `REDIS_ARTIFACT_BACKEND` is the only switch. Local dev and production read
 * the same variable, so there is no "works on my machine" storage split — just
 * a different value in .env.
 *
 *   local → filesystem (fine for dev; NOT viable on Cloud Run, see below)
 *   r2   → Cloudflare R2 (S3-compatible, $0 egress)
 *
 * Why local is not a production option: a Cloud Run container's writable
 * filesystem is memory-backed, capped around 512 MB, not shared between
 * instances, and wiped on recycle/redeploy/scale-to-zero. An RDB would either
 * fail to write or vanish silently while its row still says "Stored".
 */
export function getArtifactStore(env: {
  REDIS_ARTIFACT_BACKEND?: string;
  REDIS_ARTIFACT_DIR?: string;
  R2_ACCOUNT_ID?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_BUCKET?: string;
  R2_ENDPOINT?: string;
}): ArtifactStore {
  if (cached) return cached;

  const backend = (env.REDIS_ARTIFACT_BACKEND ?? "local").toLowerCase();

  if (backend === "r2") {
    // Static import, not a lazy require(): this package is ESM ("type":
    // "module"), so `require` is undefined at runtime even though @types/node
    // makes it typecheck. A static import also keeps getArtifactStore sync.
    cached = new R2ArtifactStore({
      accountId: env.R2_ACCOUNT_ID ?? process.env.R2_ACCOUNT_ID ?? "",
      accessKeyId: env.R2_ACCESS_KEY_ID ?? process.env.R2_ACCESS_KEY_ID ?? "",
      secretAccessKey: env.R2_SECRET_ACCESS_KEY ?? process.env.R2_SECRET_ACCESS_KEY ?? "",
      bucket: env.R2_BUCKET ?? process.env.R2_BUCKET ?? "",
      endpoint: env.R2_ENDPOINT ?? process.env.R2_ENDPOINT,
    });
    return cached;
  }

  if (backend !== "local") {
    throw createAppError(
      500,
      `REDIS_ARTIFACT_BACKEND "${backend}" is not a known backend — use "local" or "r2"`,
      "ARTIFACT_BACKEND_UNAVAILABLE"
    );
  }

  cached = new LocalDiskArtifactStore(env.REDIS_ARTIFACT_DIR ?? "./data/redis-artifacts");
  return cached;
}

/** Test hook — lets a suite swap stores without re-reading env */
export function __resetArtifactStoreCache(): void {
  cached = null;
}

/**
 * Build the storage key for a Redis snapshot.
 *
 * Deliberately not reversible to the customer: the host and database name are
 * excluded. Two customers pointing at the same Redis must not be able to guess
 * each other's key from an API response.
 *
 * The extension is derived from the ACTUAL encoding, never from intent. An
 * earlier version hardcoded `.rdb.zst` while storing raw bytes; the extension
 * now has to agree with `redis_snapshots.compression` or restore breaks.
 */
export function buildRedisArtifactKey(params: {
  organizationId: string;
  redisResourceId: string;
  snapshotId: string;
  capturedAt: Date;
  compression?: RedisArtifactCompression;
}): string {
  const day = params.capturedAt.toISOString().slice(0, 10);
  const ext = artifactExtension(params.compression ?? "none");
  return `redis/${params.organizationId}/${params.redisResourceId}/${day}/${params.snapshotId}${ext}`;
}

// ─── Compression ────────────────────────────────────────────────────────────

/**
 * How a stored artifact is encoded. Recorded per snapshot so a restore never
 * has to guess — mixing encodings across a TTL window is inevitable once more
 * than one setting has been used.
 *
 * MEASURED, NOT ASSUMED. An earlier version of this file claimed that an RDB
 * was "already LZF-compressed, so a second pass recovers only ~5-15%" and
 * defaulted to no compression. That was wrong, and it was measured wrong:
 *
 *   20k JSON product docs  RDB 2,089,173 B → gzip 274,129 B   (86.9% smaller)
 *   40k mixed cache keys  RDB 2,900,435 B → gzip 788,756 B   (72.8% smaller)
 *                          same          → zstd 716,642 B   (75.3% smaller)
 *   gunzip throughput     ~322 MB/s single core
 *
 * The mistake was assuming LZF's compression ratio approximates a modern
 * codec's. LZF is optimised for SPEED during BGSAVE, not ratio, and it leaves
 * a great deal on the table. Real cache payloads are JSON-shaped with
 * repeated key structure, which is close to the best case for DEFLATE.
 *
 * Hence 'gzip' as the default: 3-7x less to store, and at ~322 MB/s to read
 * back, decompression is not a meaningful part of restore time.
 *
 * 'zstd' is available too but needs Node >= 22.15/23.8, so it is opt-in rather
 * than the default — see resolveRedisArtifactCompression.
 */
export type RedisArtifactCompression = "none" | "gzip" | "zstd";

export const REDIS_ARTIFACT_COMPRESSIONS: readonly RedisArtifactCompression[] = [
  "none",
  "gzip",
  "zstd",
];

export function artifactExtension(compression: RedisArtifactCompression): string {
  if (compression === "gzip") return ".rdb.gz";
  if (compression === "zstd") return ".rdb.zst";
  return ".rdb";
}

/** zstd landed in Node's zlib at 22.15 / 23.8 — check, don't assume. */
export function isZstdSupported(): boolean {
  return typeof (zlib as { zstdCompressSync?: unknown }).zstdCompressSync === "function";
}

/**
 * Honour the configured encoding, degrading to 'none' if the runtime cannot do
 * it. A missing zstd must never turn into a corrupt restore or a crash mid-put.
 */
export function resolveRedisArtifactCompression(
  configured: string | undefined
): RedisArtifactCompression {
  const value = (configured ?? "gzip").toLowerCase();
  if (value === "zstd") return isZstdSupported() ? "zstd" : "gzip";
  if (value === "gzip") return "gzip";
  return "none";
}

/**
 * Encode an RDB for storage.
 *
 * Returns the original buffer untouched when compression is off, so that path
 * costs nothing and the stored bytes are exactly what Redis produced.
 */
export function encodeArtifact(
  raw: Buffer,
  compression: RedisArtifactCompression
): { data: Buffer; compression: RedisArtifactCompression } {
  if (compression === "none") return { data: raw, compression };
  if (compression === "zstd") {
    return {
      data: zlib.zstdCompressSync!(raw, {
        params: { [constants.ZSTD_c_compressionLevel]: 9 },
      }),
      compression,
    };
  }
  return { data: zlib.gzipSync(raw, { level: 6 }), compression };
}

/**
 * Decode an artifact for restore. `compression` comes from the DB row, so this
 * is symmetric with whatever was actually written — not with what is configured
 * today, which may have changed since the artifact was written.
 */
export function decodeArtifact(
  data: Buffer,
  compression: RedisArtifactCompression
): Buffer {
  if (compression === "none") return data;
  if (compression === "zstd") return zlib.zstdDecompressSync!(data);
  return zlib.gunzipSync(data);
}