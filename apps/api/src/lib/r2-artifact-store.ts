/**
 * Cloudflare R2 artifact store — S3-compatible object storage.
 *
 * WHY R2 AND NOT S3
 *
 * Every restore pulls the artifact back down, so egress is the line item that
 * scales with SUCCESS, not with usage. R2 charges $0/GB egress and has a 10 GB
 * free tier. AWS S3 and GCS bill per-GB egress, which on a restore-heavy product
 * quietly becomes the biggest cost in the stack. B2 is the same story; MinIO is
 * the same API if you would rather self-host.
 *
 * Because R2 speaks the S3 API, this backend also works against B2 and any
 * S3-compatible MinIO by changing the endpoint — no code change.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * TTL IS THE PROVIDER'S JOB HERE, NOT OURS
 *
 * The app sweeper is belt-and-braces. Once artifacts live in a bucket, set a
 * Cloudflare lifecycle rule that deletes after the retention window — then an
 * artifact is deleted even if Revenant is completely down, which on Cloud Run's
 * ephemeral filesystem was impossible.
 *
 * Suggested rules (set these in the dashboard when you create the bucket):
 *   Starter objects → expire after 1 day
 *   Pro objects     → expire after 7 days
 * The app records the exact per-snapshot deadline in redis_snapshots.expires_at
 * and deletes sooner when it can; the lifecycle rule is the backstop.
 */
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

import { createAppError } from "./errors.js";
import type { StoredArtifact } from "./artifact-store.js";

/**
 * Every object in this bucket MUST live under this prefix.
 *
 * The bucket is dedicated to Redis, and this makes that a checked invariant
 * rather than a convention someone can quietly break. If a future change ever
 * points this store at evidence artifacts or job uploads, it fails loudly here
 * instead of interleaving unrelated object types in a bucket that has a
 * `redis/`-scoped lifecycle rule attached to it.
 *
 * Pair this with the Cloudflare lifecycle rule (prefix `redis/`, delete after
 * 1 day) so anything outside the prefix is simply never eligible for expiry —
 * and therefore never accidentally swept away by someone else's rule.
 */
export const R2_ALLOWED_PREFIX = "redis/";

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /** Optional — some self-hosted endpoints need it; R2 does not. */
  endpoint?: string;
}

export class R2ArtifactStore {
  readonly name = "cloudflare-r2";

  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: R2Config) {
    if (!config.accountId || !config.accessKeyId || !config.secretAccessKey || !config.bucket) {
      throw createAppError(
        500,
        "R2 artifact store is missing credentials — set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET",
        "ARTIFACT_CONFIG_INCOMPLETE"
      );
    }

    this.bucket = config.bucket;
    this.client = new S3Client({
      region: "auto",
      // R2 ignores the region but the SDK requires one.
      endpoint:
        config.endpoint ?? `https://${config.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      // R2 returns its own errors; forcePathStyle keeps keys working across
      // S3-compatible providers that do not do virtual-host style.
      forcePathStyle: true,
    });
  }

  /** Redis-only bucket: refuse any key outside the reserved prefix. */
  private assertRedisOnlyKey(key: string): void {
    if (!key.startsWith(R2_ALLOWED_PREFIX)) {
      throw createAppError(
        500,
        `R2 bucket "${this.bucket}" is Redis-only; refusing key "${key}" because it is outside the "${R2_ALLOWED_PREFIX}" prefix`,
        "ARTIFACT_PREFIX_VIOLATION"
      );
    }
  }

  async put(key: string, data: Buffer): Promise<StoredArtifact> {
    this.assertRedisOnlyKey(key);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: data,
        ContentType: "application/octet-stream",
        ContentLength: data.byteLength,
      })
    );
    // R2 computes the same SHA-256 the local store records, but we hash here
    // so both backends produce an identical checksum for the same bytes.
    const { createHash } = await import("node:crypto");
    return {
      key,
      byteSize: data.byteLength,
      checksumSha256: createHash("sha256").update(data).digest("hex"),
    };
  }

  async get(key: string): Promise<Buffer> {
    this.assertRedisOnlyKey(key);
    try {
      const res = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key })
      );
      const body = res.Body as unknown;
      if (!body) {
        throw createAppError(404, "Artifact not found or already expired", "ARTIFACT_NOT_FOUND");
      }
      // In Node the S3 SDK returns a stream; collect it fully.
      const chunks: Buffer[] = [];
      for await (const chunk of body as AsyncIterable<Uint8Array>) {
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    } catch (err) {
      if (err instanceof Error && "name" in err && (err as { name?: string }).name === "NoSuchKey") {
        throw createAppError(404, "Artifact not found or already expired", "ARTIFACT_NOT_FOUND");
      }
      throw err;
    }
  }

  async exists(key: string): Promise<boolean> {
    this.assertRedisOnlyKey(key);
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key })
      );
      return true;
    } catch {
      return false;
    }
  }

  /** Idempotent: deleting a missing key must not throw, or the sweeper wedges. */
  async delete(key: string): Promise<void> {
    this.assertRedisOnlyKey(key);
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key })
    );
  }
}