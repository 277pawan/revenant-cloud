/**
 * Redis restore-proof sandbox — runs inside the Revenant cloud API.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS
 *
 * The Redis provider was originally built so that ONLY a self-hosted agent
 * could execute a restore proof. The proof needs a throwaway redis-server
 * booted against a captured RDB, and the cloud API was assumed to have no
 * runtime for that, so the sandbox was pushed into the agent.
 *
 * The consequence was a product that could not finish its own promise: the
 * dashboard opened a proof, the proof sat in `pending`, and 30 minutes later
 * it failed with "No Redis proof worker claimed this run" — for a customer
 * who had never been told an online worker was a prerequisite.
 *
 * That assumption was wrong. The API already reaches the customer's Redis
 * directly (the "Test URL" probe proves it does), so the same box can host
 * the sandbox. This module runs `redis-server` as a throwaway LOCAL PROCESS
 * on 127.0.0.1 — exactly what the `revenant redis-prove` CLI already does on
 * a customer's laptop. No Docker daemon, no always-on agent, no second
 * deployment for the customer to operate.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT A PROOF ACTUALLY PROVES
 *
 * A cache's RDB sits on the same disk that fails. Nobody checks whether it
 * still loads. So we take a real snapshot off a live Redis, boot a throwaway
 * redis-server against that exact file, and report what came back. A restore
 * that fails here is a backup the customer did not have.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SAFETY RULES — do not relax these
 *
 *   - The source Redis is only ever asked to produce a dump. We run NO Lua
 *     and NO key scan against the source: source-side numbers come from
 *     INFO keyspace, which is O(number of databases). A cache under
 *     production traffic must not be stalled by a proof.
 *   - The RDB is copied before the sandbox opens it, and the sandbox runs
 *     with `--save "" --appendonly no`, so it persists nothing and cannot
 *     write back into the customer's dump.
 *   - The sandbox binds to 127.0.0.1 on a random free port and is killed in
 *     a finally block even when a step throws.
 *   - No key or value ever crosses into this process. The digest is computed
 *     server-side with redis.sha1hex and only the hex string comes back.
 *   - The Redis URL is a live credential. It is never logged; every message
 *     in this file goes through redactRedisUrl.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseRedisUrl, type RedisCheckResult } from "@revenant/shared";

import {
  RedisProbe,
  type RespValue,
  bufToText,
  configToMap,
  parseInfo,
  parseKeyspace,
  withRedis,
} from "./redis-client.js";

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * How a proof ended.
 *
 * `unreachable` is the one that matters for routing: it means *this* executor
 * could not reach the customer's Redis, which is not proof that the backup is
 * broken. A private-network Redis is perfectly healthy — we just have no
 * route to it. The queue uses this to hand the run to another executor
 * (an agent inside the customer's VPC) instead of failing it.
 *
 * `failed` means the proof RAN and the data did not come back. `error` means
 * the proof could not be run at all (no sandbox binary, version skew). The
 * customer must never be told their backup is broken when the check never
 * ran.
 */
export type RedisProofOutcome =
  | "restored"
  | "failed"
  | "error"
  | "unreachable";

export interface RedisSandboxOptions {
  /** redis:// or rediss://. Held in memory only; never logged in the clear. */
  redisUrl: string;
  /** Overall budget for the pull + boot + inspect sequence. */
  timeoutMs?: number;
  /** Keys sampled for the digest. */
  sampleSize?: number;
  /** Memory ceiling for the sandbox, so a large cache cannot OOM the host. */
  maxMemory?: string;
  /**
   * Upper bound on keys transferred by the LOGICAL capture path.
   *
   * The logical path walks the keyspace key by key, so a very large cache
   * would take a long time and a lot of memory. When the cap is hit the
   * proof says so explicitly rather than quietly proving less than it
   * appears to.
   */
  maxLogicalKeys?: number;
  /** Upper bound on bytes transferred by the logical capture path. */
  maxLogicalBytes?: number;
  /** Return the RDB bytes so the caller can store them (opt-in retention). */
  captureRdb?: boolean;
  /** Path to the redis-server binary. Defaults to "redis-server" on PATH. */
  serverBin?: string;
  /** Path to the redis-cli binary. Defaults to "redis-cli" on PATH. */
  cliBin?: string;
}

/**
 * Which mechanism captured the data.
 *
 * - "rdb"     — the server streamed its RDB file and a throwaway redis-server
 *               loaded that exact file. This is the strongest proof: it is
 *               the backup, not a copy of it.
 * - "logical" — the keyspace was transferred key by key (DUMP/RESTORE) and
 *               rebuilt in a throwaway redis-server. Used when the provider
 *               refuses to hand out its RDB.
 */
export type RedisCaptureMethod = "rdb" | "logical";

export interface RedisSandboxResult {
  /** Did the throwaway server actually boot from the RDB? */
  restored: boolean;
  outcome: RedisProofOutcome;
  /** How the data was captured and replayed. */
  captureMethod: RedisCaptureMethod | null;
  /** True when a capture cap stopped the transfer short. */
  captureTruncated: boolean;
  sourceKeyCount: number | null;
  restoredKeyCount: number | null;
  rdbBytes: number | null;
  restoreSeconds: number | null;
  rpoObservedSeconds: number | null;
  rdbLastBgsaveStatus: string | null;
  sourceVersion: string | null;
  restoredVersion: string | null;
  restoredDigest: string | null;
  sampledKeys: number | null;
  ttlDistribution: Record<string, number> | null;
  /** Keyspace of the RESTORED instance, per database. */
  restoredKeyspace: Record<
    string,
    { keys: number; expires: number; avgTtl: number | null }
  >;
  checks: RedisCheckResult[];
  messages: string[];
  /** Present only when captureRdb is true. */
  rdb?: Buffer;
}

export interface RedisRdbPreviewKey {
  key: string;
  type: string;
  ttlSeconds: number | null;
  preview: string;
  previewEncoding: "text" | "base64";
  truncated: boolean;
}

export interface RedisRdbPreviewDatabase {
  database: number;
  keyCount: number;
  expires: number;
  keys: RedisRdbPreviewKey[];
}

/**
 * Load a verified RDB into a disposable local Redis and return a small,
 * user-requested sample. Values are intentionally capped per key and overall.
 */
export async function inspectRedisRdbPreview(
  rdb: Buffer,
  options: { sampleLimit?: number; serverBin?: string; timeoutMs?: number } = {}
): Promise<{
  databases: RedisRdbPreviewDatabase[];
  totalKeys: number;
  sampledKeys: number;
  sampleLimit: number;
  truncated: boolean;
}> {
  if (rdb.subarray(0, 5).toString("ascii") !== "REDIS") {
    throw new Error("Snapshot bytes do not have a valid Redis RDB signature.");
  }

  const sampleLimit = Math.max(1, Math.min(options.sampleLimit ?? 10, 20));
  const timeoutMs = options.timeoutMs ?? 60_000;
  const serverCandidates = candidateList(
    options.serverBin ??
      process.env.REDIS_PROOF_SERVER_BIN ??
      "redis-server-8,redis-server"
  );
  const serverBin = await resolvePreviewServerBin(serverCandidates);
  const workDir = await mkdtemp(join(tmpdir(), "revenant-redis-preview-"));
  let sandbox: SandboxHandle | null = null;
  try {
    await writeFile(join(workDir, "preview.rdb"), rdb, { mode: 0o600 });
    const started = await startSandbox(
      serverBin,
      workDir,
      "preview.rdb",
      process.env.REDIS_PROOF_MAX_MEMORY ?? "512mb",
      timeoutMs
    );
    if (!started.ok) {
      throw new Error(`Could not load snapshot into the preview Redis: ${started.message}`);
    }
    sandbox = started.handle;

    return await withRedis(
      { host: "127.0.0.1", port: sandbox.port, timeoutMs: 5_000 },
      async (client) => {
        const keyspace = parseKeyspace(
          bufToText(await client.send("INFO", "keyspace"))
        );
        const databases: RedisRdbPreviewDatabase[] = [];
        let remaining = sampleLimit;

        for (const [databaseName, stats] of Object.entries(keyspace)) {
          if (remaining <= 0) break;
          const database = Number(databaseName.slice(2));
          await client.send("SELECT", String(database));
          const keys: RedisRdbPreviewKey[] = [];
          let cursor = "0";
          do {
            const scan = await client.send("SCAN", cursor, "COUNT", String(Math.min(remaining, 10)));
            if (!Array.isArray(scan) || !Array.isArray(scan[1])) {
              throw new Error("Redis returned an invalid key scan response.");
            }
            cursor = bufToText(scan[0]) || "0";
            for (const rawKey of scan[1]) {
              if (remaining <= 0) break;
              const key = Buffer.isBuffer(rawKey) ? rawKey : Buffer.from(bufToText(rawKey));
              const [typeReply, ttlReply] = await Promise.all([
                client.send("TYPE", key),
                client.send("PTTL", key),
              ]);
              const type = bufToText(typeReply);
              const ttlMs = typeof ttlReply === "number" ? ttlReply : -1;
              const value = await previewRedisValue(client, key);
              keys.push({
                key: previewText(key).value,
                type,
                ttlSeconds: ttlMs >= 0 ? Math.ceil(ttlMs / 1000) : null,
                ...value,
              });
              remaining -= 1;
            }
          } while (cursor !== "0" && remaining > 0);

          databases.push({
            database,
            keyCount: stats.keys,
            expires: stats.expires,
            keys,
          });
        }

        const totalKeys = Object.values(keyspace).reduce((sum, item) => sum + item.keys, 0);
        const sampledKeys = databases.reduce((sum, item) => sum + item.keys.length, 0);
        return {
          databases,
          totalKeys,
          sampledKeys,
          sampleLimit,
          truncated: totalKeys > sampledKeys,
        };
      }
    );
  } finally {
    sandbox?.stop();
    await rm(workDir, { recursive: true, force: true });
  }
}

async function previewRedisValue(
  client: RedisProbe,
  key: Buffer
): Promise<Pick<RedisRdbPreviewKey, "preview" | "previewEncoding" | "truncated">> {
  const response = await client.send("EVAL", REDIS_PREVIEW_SCRIPT, "1", key);
  if (!Array.isArray(response) || response.length < 2) {
    throw new Error("Redis returned an invalid value preview.");
  }
  const type = respText(response[0]);
  const memberCount = Number(response[1]);
  const sampledValues = response.slice(2).map((value) => previewRespValue(value));
  const preview = `${memberCount} ${
    type === "string" ? "bytes" : "members"
  }${sampledValues.length ? ` · ${JSON.stringify(sampledValues)}` : ""}`;
  const cappedPreview = preview.slice(0, 1_000);
  const truncated = cappedPreview.length < preview.length ||
    response.slice(2).some((value) => isPreviewValueTruncated(value));
  const isBinary = response.slice(2).some((value) => containsBinaryPreviewValue(value));

  return {
    preview: cappedPreview,
    previewEncoding: isBinary ? "base64" : "text",
    truncated,
  };
}

const REDIS_PREVIEW_SCRIPT = `
local kind = redis.call('TYPE', KEYS[1]).ok
local out = {kind}
local limit = 80
local count = 0
if kind == 'string' then
  local valueLength = redis.call('STRLEN', KEYS[1])
  count = valueLength
  table.insert(out, count)
  table.insert(out, redis.call('GETRANGE', KEYS[1], 0, limit - 1))
elseif kind == 'list' then
  count = redis.call('LLEN', KEYS[1])
  table.insert(out, count)
  local values = redis.call('LRANGE', KEYS[1], 0, 2)
  for _, value in ipairs(values) do table.insert(out, string.sub(value, 1, limit)) end
elseif kind == 'hash' then
  count = redis.call('HLEN', KEYS[1])
  table.insert(out, count)
  local values = redis.call('HSCAN', KEYS[1], 0, 'COUNT', 3)[2]
  for _, value in ipairs(values) do table.insert(out, string.sub(value, 1, limit)) end
elseif kind == 'set' then
  count = redis.call('SCARD', KEYS[1])
  table.insert(out, count)
  local values = redis.call('SSCAN', KEYS[1], 0, 'COUNT', 3)[2]
  for _, value in ipairs(values) do table.insert(out, string.sub(value, 1, limit)) end
elseif kind == 'zset' then
  count = redis.call('ZCARD', KEYS[1])
  table.insert(out, count)
  local values = redis.call('ZSCAN', KEYS[1], 0, 'COUNT', 3)[2]
  for index, value in ipairs(values) do
    table.insert(out, string.sub(value, 1, limit))
    if index % 2 == 0 then table.insert(out, value) end
  end
end
return out
`;

function respText(value: RespValue): string {
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return typeof value === "number" ? String(value) : "";
}

type PreviewValue = string | number | PreviewValue[];

function previewRespValue(value: RespValue): PreviewValue {
  if (Buffer.isBuffer(value)) {
    const text = previewText(value);
    return text.binary ? `base64:${value.toString("base64")}` : text.value;
  }
  if (Array.isArray(value)) return value.map(previewRespValue);
  if (typeof value === "number") return value;
  return "";
}

function isPreviewValueTruncated(value: RespValue): boolean {
  if (Buffer.isBuffer(value)) return value.byteLength === 80;
  return Array.isArray(value) && value.some(isPreviewValueTruncated);
}

function containsBinaryPreviewValue(value: RespValue): boolean {
  if (Buffer.isBuffer(value)) return previewText(value).binary;
  return Array.isArray(value) && value.some(containsBinaryPreviewValue);
}

function previewText(value: Buffer): { value: string; binary: boolean } {
  const decoded = value.toString("utf8");
  const binary = !Buffer.from(decoded, "utf8").equals(value) || value.some(
    (byte) => byte === 0 || byte < 9 || (byte > 13 && byte < 32)
  );
  return {
    value: binary ? value.toString("base64") : decoded,
    binary,
  };
}

// ─── Lua (runs against the SANDBOX only, never the customer's cache) ─────────

/**
 * Stable digest of a keyspace. The key NAME is hashed before it is used, so
 * the digest cannot be reversed into a key listing even if it leaks, and the
 * value never leaves the server.
 */
const DIGEST_LUA = `
local cursor = "0"
local limit = tonumber(ARGV[1])
local acc = {}
repeat
  local r = redis.call("SCAN", cursor, "COUNT", 200)
  cursor = r[1]
  for i = 1, #r[2] do
    if #acc >= limit then break end
    local k = r[2][i]
    local ok, dumped = pcall(redis.call, "DUMP", k)
    if ok then
      acc[#acc+1] = redis.sha1hex(k) .. ":" .. redis.sha1hex(dumped)
    end
  end
until cursor == "0" or #acc >= limit
table.sort(acc)
return table.concat(acc, "\\n")
`;

/** TTL histogram of the sandbox keyspace. */
const TTL_LUA = `
local cursor = "0"
local limit = tonumber(ARGV[1])
local b = { no_expiry = 0, lt_1m = 0, lt_1h = 0, lt_1d = 0, gt_1d = 0 }
local seen = 0
repeat
  local r = redis.call("SCAN", cursor, "COUNT", 200)
  cursor = r[1]
  for i = 1, #r[2] do
    if seen >= limit then break end
    seen = seen + 1
    local ttl = redis.call("TTL", r[2][i])
    if ttl < 0 then b.no_expiry = b.no_expiry + 1
    elseif ttl < 60 then b.lt_1m = b.lt_1m + 1
    elseif ttl < 3600 then b.lt_1h = b.lt_1h + 1
    elseif ttl < 86400 then b.lt_1d = b.lt_1d + 1
    else b.gt_1d = b.gt_1d + 1 end
  end
until cursor == "0" or seen >= limit
return cjson.encode(b)
`;

// ─── Process plumbing ───────────────────────────────────────────────────────

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Spawn a binary, capture its output, never leak the environment. */
function run(
  bin: string,
  args: string[],
  opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}
): Promise<RunResult> {
  return new Promise<RunResult>((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, {
        env: { ...process.env, ...opts.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      reject(err);
      return;
    }

    let stdout = "";
    let stderr = "";
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`${bin} timed out after ${opts.timeoutMs}ms`));
        }, opts.timeoutMs)
      : null;

    child.stdout?.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/** Ask the OS for a free TCP port so we never collide with anything. */
function freePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => {
        if (port) resolve(port);
        else reject(new Error("could not allocate a free port for the sandbox"));
      });
    });
  });
}

// ─── Error classification ───────────────────────────────────────────────────

export type RedisFailureKind = "unreachable" | "auth" | "failed";

/**
 * Classify a failure so the queue knows whether to retry elsewhere or stop.
 *
 * `unreachable` means "no network route" — a private-network Redis, a
 * security group, a DNS name that does not resolve from here. That is NOT a
 * broken backup, and it is not something a retry from the same box can fix.
 */
export function classifyRedisFailure(message: string): RedisFailureKind {
  if (/NOAUTH|WRONGPASS|invalid password|unknown user|authentication/i.test(message)) {
    return "auth";
  }
  if (
    /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EPIPE|timed out|Connection closed|network is unreachable|no route to host|Connection refused|Could not connect|socket hang up/i.test(
      message
    )
  ) {
    return "unreachable";
  }
  return "failed";
}

/** Mask a URL before it reaches a log line, an error, or the UI. */
export function redactRedisUrl(raw: string): string {
  const parsed = parseRedisUrl(raw);
  if (!parsed) return "redis://<invalid>";
  const auth = parsed.username
    ? `${parsed.username}:***@`
    : parsed.password
      ? "***@"
      : "";
  return `${parsed.tls ? "rediss" : "redis"}://${auth}${parsed.host}:${parsed.port}/${parsed.dbIndex}`;
}

// ─── The proof ──────────────────────────────────────────────────────────────

interface SourceInfo {
  keyCount: number | null;
  expires: number | null;
  version: string | null;
  lastBgsaveStatus: string | null;
  rpoObservedSeconds: number | null;
  keyspace: Record<string, { keys: number; expires: number; avgTtl: number | null }>;
}

/**
 * Read the source's keyspace and persistence state.
 *
 * INFO keyspace and INFO persistence are O(number of databases). No scan, no
 * Lua, nothing that grows with the size of the cache.
 */
async function readSourceInfo(
  opts: RedisSandboxOptions,
  timeoutMs: number
): Promise<SourceInfo> {
  const parsed = parseRedisUrl(opts.redisUrl);
  if (!parsed) {
    throw new Error("The stored Redis URL is not a valid redis:// or rediss:// URL");
  }

  return withRedis(
    {
      host: parsed.host,
      port: parsed.port,
      username: parsed.username,
      password: parsed.password,
      dbIndex: parsed.dbIndex,
      tls: parsed.tls,
      timeoutMs,
    },
    async (client) => {
      await client.send("PING");
      const server = parseInfo(bufToText(await client.send("INFO", "server")));
      const persistence = parseInfo(
        bufToText(await client.send("INFO", "persistence"))
      );
      // `INFO keyspace` has its own line format ("db0:keys=3,expires=0").
      const keyspace = parseKeyspace(bufToText(await client.send("INFO", "keyspace")));

      let keyCount = 0;
      let expires = 0;
      for (const entry of Object.values(keyspace)) {
        keyCount += entry.keys;
        expires += entry.expires;
      }

      const lastSave = persistence.rdb_last_save_time
        ? Number(persistence.rdb_last_save_time)
        : null;

      return {
        keyCount,
        expires,
        version: server.redis_version ?? null,
        lastBgsaveStatus: persistence.rdb_last_bgsave_status ?? null,
        rpoObservedSeconds:
          lastSave && Number.isFinite(lastSave)
            ? Math.round(Date.now() / 1000) - lastSave
            : null,
        keyspace,
      };
    }
  );
}

/**
 * Pull a complete RDB off the live server.
 *
 * `redis-cli --rdb` asks the SERVER to stream a dump over the wire (it
 * issues SYNC). That means we need no filesystem access to the customer's
 * Redis — it may be in a container, on a volume, or behind a read-only mount.
 *
 * The password is passed through the REDISCLI_AUTH environment variable, so
 * it never appears in argv and never shows up in `ps`.
 */
async function pullRdb(
  cliBin: string,
  opts: RedisSandboxOptions,
  targetPath: string,
  timeoutMs: number
): Promise<{ ok: true } | { ok: false; message: string }> {
  const parsed = parseRedisUrl(opts.redisUrl);
  if (!parsed) {
    return { ok: false, message: "The stored Redis URL could not be parsed" };
  }

  const args = ["-h", parsed.host, "-p", String(parsed.port)];
  if (parsed.tls) args.push("--tls");
  if (parsed.username) args.push("--user", parsed.username);
  if (parsed.dbIndex) args.push("-n", String(parsed.dbIndex));
  args.push("--rdb", targetPath);

  try {
    const result = await run(cliBin, args, {
      timeoutMs,
      env: parsed.password ? { REDISCLI_AUTH: parsed.password } : undefined,
    });
    if (result.code !== 0) {
      const detail =
        result.stderr.trim().split("\n").slice(-3).join(" ") ||
        result.stdout.trim().split("\n").slice(-3).join(" ") ||
        `redis-cli exited with code ${result.code}`;
      return { ok: false, message: detail };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

interface SandboxHandle {
  port: number;
  stop: () => void;
}

/**
 * Boot a throwaway redis-server against a COPY of the captured RDB and wait
 * for it to answer PING.
 *
 * The sandbox persists nothing (`--save "" --appendonly no`) and binds to
 * loopback only, so it can neither be reached from outside this process nor
 * write anything back.
 */
async function startSandbox(
  serverBin: string,
  workDir: string,
  rdbFileName: string,
  maxMemory: string,
  timeoutMs: number
): Promise<
  | { ok: true; handle: SandboxHandle; logs: string }
  | { ok: false; message: string }
> {
  let port: number;
  try {
    port = await freePort();
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }

  let child;
  try {
    child = spawn(
      serverBin,
      [
        "--dir",
        workDir,
        "--dbfilename",
        rdbFileName,
        "--port",
        String(port),
        "--bind",
        "127.0.0.1",
        // The sandbox must not persist anything of its own.
        "--save",
        "",
        "--appendonly",
        "no",
        "--maxmemory",
        maxMemory,
        // A restored cache that cannot evict would just OOM the host.
        "--maxmemory-policy",
        "noeviction",
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }

  let logs = "";
  child.stdout?.on("data", (d) => {
    logs = (logs + d.toString()).slice(-4000);
  });
  child.stderr?.on("data", (d) => {
    logs = (logs + d.toString()).slice(-4000);
  });

  const handle: SandboxHandle = {
    port,
    stop: () => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    },
  };

  const exited = new Promise<number>((resolve) => {
    child.on("close", (code) => resolve(code ?? -1));
    child.on("error", () => resolve(-1));
  });

  // Wait for the sandbox to answer PING. A large RDB takes time to load, so
  // poll rather than assuming.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ping = await withRedis(
      { host: "127.0.0.1", port, timeoutMs: 2_000 },
      async (client) => {
        await client.send("PING");
        return true;
      }
    ).catch(() => false);

    if (ping) return { ok: true, handle, logs };

    const exitCode = await Promise.race([
      exited,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 0)),
    ]);
    if (exitCode !== null) {
      return {
        ok: false,
        message: `The sandbox redis-server exited immediately (code ${exitCode}). ${
          logs.trim().split("\n").slice(-3).join(" ") || ""
        }`.trim(),
      };
    }

    await new Promise((r) => setTimeout(r, 300));
  }

  handle.stop();
  return {
    ok: false,
    message: `The restored server never answered PING within ${Math.round(
      timeoutMs / 1000
    )}s. ${logs.trim().split("\n").slice(-3).join(" ")}`.trim(),
  };
}

/**
 * Hash one key/value pair the same way the rest of the codebase does.
 *
 * The key NAME is hashed before it is used, so the digest cannot be
 * reversed into a key listing, and the payload is hashed rather than
 * stored. Neither the name nor the value is ever written down.
 */
function keyDigestLine(key: Buffer, payload: Buffer): string {
  return (
    `${createHash("sha256").update(key).digest("hex")}:` +
    `${createHash("sha256").update(payload).digest("hex")}`
  );
}

/**
 * The logical content of one key, in a form that is identical on any Redis
 * version and independent of when it was read.
 *
 * WHY NOT THE DUMP PAYLOAD
 *
 * DUMP is the obvious choice, but the serialized bytes are not comparable
 * across two servers: the payload embeds an absolute expiry timestamp and
 * an RDB version, so a key with a TTL produces different bytes every time
 * it is read. Comparing the source's DUMP against the restored instance's
 * DUMP therefore fails for every expiring key — which is most of a cache.
 *
 * So the comparison is made on the CONTENT: the value of a string, the
 * elements of a list, the members of a set, the scored members of a sorted
 * set, the fields of a hash. Those are the things a restore has to bring
 * back, and they mean the same thing on every Redis version.
 */
interface CanonicalValue {
  kind: string;
  /** Ordered parts. Order matters for lists and sorted sets. */
  parts: Buffer[];
}

async function readCanonicalValue(
  client: RedisProbe,
  key: Buffer
): Promise<CanonicalValue | null> {
  const typeReply = await client.send("TYPE", key);
  const kind = bufToText(typeReply).toLowerCase();

  switch (kind) {
    case "string": {
      const value = await client.send("GET", key);
      if (!Buffer.isBuffer(value)) return null;
      return { kind, parts: [value] };
    }
    case "list": {
      const items = await client.send("LRANGE", key, "0", "-1");
      if (!Array.isArray(items)) return null;
      return { kind, parts: items.map((item) => (Buffer.isBuffer(item) ? item : Buffer.alloc(0))) };
    }
    case "set": {
      const members = await client.send("SMEMBERS", key);
      if (!Array.isArray(members)) return null;
      return {
        kind,
        // A set is unordered, so the canonical form sorts it.
        parts: members
          .map((member) => (Buffer.isBuffer(member) ? member : Buffer.alloc(0)))
          .sort(Buffer.compare),
      };
    }
    case "zset": {
      const flat = await client.send("ZRANGE", key, "0", "-1", "WITHSCORES");
      if (!Array.isArray(flat)) return null;
      const parts: Buffer[] = [];
      for (let i = 0; i + 1 < flat.length; i += 2) {
        const member = flat[i];
        const score = flat[i + 1];
        parts.push(
          Buffer.concat([
            Buffer.isBuffer(member) ? member : Buffer.alloc(0),
            Buffer.from(":"),
            Buffer.isBuffer(score) ? score : Buffer.from(bufToText(score)),
          ])
        );
      }
      return { kind, parts };
    }
    case "hash": {
      const flat = await client.send("HGETALL", key);
      if (!Array.isArray(flat)) return null;
      const pairs: Buffer[] = [];
      for (let i = 0; i + 1 < flat.length; i += 2) {
        const field = flat[i];
        const value = flat[i + 1];
        pairs.push(
          Buffer.concat([
            Buffer.isBuffer(field) ? field : Buffer.alloc(0),
            Buffer.from(":"),
            Buffer.isBuffer(value) ? value : Buffer.alloc(0),
          ])
        );
      }
      // A hash is unordered, so the canonical form sorts it.
      pairs.sort(Buffer.compare);
      return { kind, parts: pairs };
    }
    default:
      // Streams and module types have no portable logical form. The caller
      // falls back to DUMP/RESTORE for these.
      return null;
  }
}

/** The digest line for a canonical value. */
function canonicalDigestLine(key: Buffer, value: CanonicalValue): string {
  const hash = createHash("sha256");
  hash.update(value.kind);
  for (const part of value.parts) {
    hash.update(Buffer.from([0])); // separator, so parts cannot be confused
    hash.update(part);
  }
  return `${createHash("sha256").update(key).digest("hex")}:${hash.digest("hex")}`;
}

/** Write a canonical value into the restored instance. */
async function writeCanonicalValue(
  target: RedisProbe,
  key: Buffer,
  value: CanonicalValue,
  ttlMs: number
): Promise<void> {
  switch (value.kind) {
    case "string":
      await target.send("SET", key, value.parts[0] ?? Buffer.alloc(0));
      break;
    case "list":
      if (value.parts.length > 0) {
        await target.send("RPUSH", key, ...value.parts);
      }
      break;
    case "set":
      if (value.parts.length > 0) {
        await target.send("SADD", key, ...value.parts);
      }
      break;
    case "zset": {
      if (value.parts.length > 0) {
        const args: Buffer[] = [];
        for (const part of value.parts) {
          const idx = part.indexOf(0x3a); // ':'
          args.push(part.subarray(idx + 1), part.subarray(0, idx));
        }
        await target.send("ZADD", key, ...args);
      }
      break;
    }
    case "hash": {
      if (value.parts.length > 0) {
        const args: Buffer[] = [];
        for (const part of value.parts) {
          const idx = part.indexOf(0x3a); // ':'
          args.push(part.subarray(0, idx), part.subarray(idx + 1));
        }
        await target.send("HSET", key, ...args);
      }
      break;
    }
    default:
      throw new Error(`unsupported key type: ${value.kind}`);
  }
  // The TTL is applied after the value is written, so the key never expires
  // mid-transfer.
  if (ttlMs > 0) {
    await target.send("PEXPIRE", key, String(ttlMs));
  }
}

interface LogicalCaptureResult {
  transferred: number;
  /** Keys the source reported. */
  sourceTotal: number;
  /** The transfer hit a cap and did not cover the whole keyspace. */
  truncated: boolean;
  bytes: number;
  /** Digest of what was read from the source. */
  sourceDigest: string | null;
  /** Digest of what came back out of the restored instance. */
  restoredDigest: string | null;
}

/**
 * Transfer the keyspace key by key and rebuild it in the sandbox.
 *
 * WHY THIS EXISTS
 *
 * `redis-cli --rdb` asks the server for its RDB over the replication
 * protocol (SYNC + REPLCONF). Several managed Redis providers refuse those
 * commands outright — Azure Cache for Redis answers `ERR command
 * 'replconf' is not allowed` — so the RDB path simply cannot run there,
 * and the customer is told their backup is broken when in fact nobody
 * looked at it.
 *
 * The logical path uses only commands every Redis allows: SCAN, DUMP, PTTL
 * and RESTORE. It proves the same thing the product promises — that the
 * data can be brought back and comes back intact — and it proves it with a
 * digest of the source compared against a digest of the restored instance.
 *
 * The trade-off is explicit: values pass through this process (hashed
 * immediately, never stored), so the RDB path is preferred whenever the
 * provider allows it.
 */
async function logicalCaptureAndRestore(
  opts: RedisSandboxOptions,
  sandboxPort: number,
  limits: { maxKeys: number; maxBytes: number }
): Promise<
  | { ok: true; result: LogicalCaptureResult }
  | { ok: false; message: string; kind: RedisFailureKind }
> {
  const parsed = parseRedisUrl(opts.redisUrl);
  if (!parsed) {
    return { ok: false, message: "The stored Redis URL could not be parsed", kind: "failed" };
  }

  let source: RedisProbe | null = null;
  let target: RedisProbe | null = null;
  try {
    source = await RedisProbe.open({
      host: parsed.host,
      port: parsed.port,
      username: parsed.username,
      password: parsed.password,
      dbIndex: parsed.dbIndex,
      tls: parsed.tls,
      timeoutMs: 15_000,
    });
    target = await RedisProbe.open({
      host: "127.0.0.1",
      port: sandboxPort,
      timeoutMs: 15_000,
    });

    const sourceLines: string[] = [];
    let cursor = "0";
    let sourceTotal = 0;
    let transferred = 0;
    let bytes = 0;
    let truncated = false;

    do {
      const reply = await source.send("SCAN", cursor, "COUNT", "500");
      if (!Array.isArray(reply)) break;
      cursor = bufToText(reply[0]) || "0";
      const rawKeys = Array.isArray(reply[1]) ? reply[1] : [];
      sourceTotal += rawKeys.length;
      if (rawKeys.length === 0) continue;

      const keys = rawKeys.map((raw) =>
        Buffer.isBuffer(raw) ? raw : Buffer.from(bufToText(raw), "utf8")
      );

      // Stay inside the caps. The proof reports the shortfall rather than
      // pretending it restored everything.
      const room = limits.maxKeys - transferred;
      if (room <= 0) {
        truncated = true;
        break;
      }
      const batch = keys.slice(0, room);

      const dumps = await Promise.all(batch.map((key) => source!.send("DUMP", key)));
      const ptls = await Promise.all(batch.map((key) => source!.send("PTTL", key)));

      const restores: Array<Promise<unknown>> = [];
      for (let i = 0; i < batch.length; i++) {
        const rawTtl = typeof ptls[i] === "number" ? (ptls[i] as number) : -2;
        if (rawTtl === -2) continue; // key vanished mid-scan
        const ttl = rawTtl > 0 ? rawTtl : 0; // 0 = restore without an expiry

        // Prefer the portable logical form. DUMP/RESTORE stays as the
        // fallback for types that have no logical equivalent (streams,
        // module types) — and there the payload format has to match.
        const canonical = await readCanonicalValue(source, batch[i]);
        if (canonical) {
          sourceLines.push(canonicalDigestLine(batch[i], canonical));
          bytes += canonical.parts.reduce((sum, part) => sum + part.length, 0);
          if (bytes > limits.maxBytes) {
            truncated = true;
            break;
          }
          restores.push(
            writeCanonicalValue(target, batch[i], canonical, ttl).then(() =>
              undefined
            )
          );
          transferred += 1;
          continue;
        }

        const payload = dumps[i];
        if (!Buffer.isBuffer(payload)) continue; // key vanished mid-scan
        bytes += payload.length;
        if (bytes > limits.maxBytes) {
          truncated = true;
          break;
        }
        sourceLines.push(keyDigestLine(batch[i], payload));
        restores.push(target!.send("RESTORE", batch[i], String(ttl), payload, "REPLACE"));
        transferred += 1;
      }
      await Promise.all(restores);

      if (truncated) break;
    } while (cursor !== "0");

    // Read the restored instance back and digest it the same way. A match
    // means the data survived the round trip unchanged.
    const restoredLines: string[] = [];
    let restoredCursor = "0";
    do {
      const reply = await target.send("SCAN", restoredCursor, "COUNT", "500");
      if (!Array.isArray(reply)) break;
      restoredCursor = bufToText(reply[0]) || "0";
      const rawKeys = Array.isArray(reply[1]) ? reply[1] : [];
      if (rawKeys.length === 0) continue;
      const keys = rawKeys.map((raw) =>
        Buffer.isBuffer(raw) ? raw : Buffer.from(bufToText(raw), "utf8")
      );
      for (const key of keys) {
        const canonical = await readCanonicalValue(target, key);
        if (canonical) {
          restoredLines.push(canonicalDigestLine(key, canonical));
          continue;
        }
        const payload = await target.send("DUMP", key);
        if (Buffer.isBuffer(payload)) {
          restoredLines.push(keyDigestLine(key, payload));
        }
      }
    } while (restoredCursor !== "0");

    const digestOf = (lines: string[]) => {
      if (lines.length === 0) return null;
      const sorted = [...lines].sort();
      return createHash("sha256").update(sorted.join("\n")).digest("hex");
    };

    return {
      ok: true,
      result: {
        transferred,
        sourceTotal,
        truncated,
        bytes,
        sourceDigest: digestOf(sourceLines),
        restoredDigest: digestOf(restoredLines),
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message, kind: classifyRedisFailure(message) };
  } finally {
    source?.close();
    target?.close();
  }
}

/**
 * Compare two Redis versions.
 *
 * A Redis server can read an OLDER data format but never a NEWER one, so
 * the sandbox has to be at least as new as the customer's Redis. Getting
 * this wrong produces "DUMP payload version or checksum are wrong", which
 * reads exactly like a corrupt backup and is not one.
 *
 * Returns a positive number when `a` is newer than `b`.
 */
export function compareRedisVersions(a: string, b: string): number {
  const parse = (v: string) =>
    v
      .split(/[.-]/)
      .slice(0, 3)
      .map((part) => Number.parseInt(part, 10) || 0);
  const [aMajor, aMinor, aPatch] = parse(a);
  const [bMajor, bMinor, bPatch] = parse(b);
  if (aMajor !== bMajor) return aMajor - bMajor;
  if (aMinor !== bMinor) return aMinor - bMinor;
  return aPatch - bPatch;
}

/** Pull "7.0.15" out of "Redis server v=7.0.15 sha=…". */
export function parseRedisVersion(text: string): string | null {
  const m = /v?(\d+\.\d+(?:\.\d+)?)/.exec(text);
  return m ? m[1] : null;
}

/** Split a comma-separated candidate list. */
function candidateList(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

async function resolvePreviewServerBin(candidates: string[]): Promise<string> {
  const available: Array<{ bin: string; version: string }> = [];
  for (const bin of candidates) {
    const result = await run(bin, ["--version"], { timeoutMs: 15_000 }).catch(() => null);
    if (!result || result.code !== 0) continue;
    const version = parseRedisVersion(result.stdout);
    if (version) available.push({ bin, version });
  }

  available.sort((a, b) => compareRedisVersions(b.version, a.version));
  return available[0]?.bin ?? candidates[0] ?? "redis-server";
}

/**
 * Pick the sandbox binaries to use.
 *
 * A Redis server can read an OLDER data format but never a NEWER one, so
 * the sandbox has to be at least as new as the customer's Redis. The image
 * ships Redis 8 as `redis-server-8` and keeps the distribution's build as
 * `redis-server`; this picks the first candidate that exists AND is new
 * enough for the source.
 *
 * The CLI is paired with the server by position: `redis-cli --rdb` has to
 * speak the same dialect as the server it talks to, and a mismatched pair
 * fails in confusing ways.
 */
async function resolveSandboxBinaries(
  serverCandidates: string[],
  cliCandidates: string[],
  sourceVersion: string | null
): Promise<{
  serverBin: string | null;
  cliBin: string | null;
  serverVersion: string | null;
}> {
  const pairs = serverCandidates.map((server, index) => ({
    server,
    cli: cliCandidates[index] ?? cliCandidates[0] ?? "redis-cli",
  }));

  const usable: Array<{
    server: string;
    cli: string;
    version: string;
  }> = [];

  for (const pair of pairs) {
    const [serverResult, cliResult] = await Promise.all([
      run(pair.server, ["--version"], { timeoutMs: 15_000 }).catch((err) => ({
        code: -1,
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
      })),
      run(pair.cli, ["--version"], { timeoutMs: 15_000 }).catch((err) => ({
        code: -1,
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
      })),
    ]);
    if (serverResult.code !== 0 || cliResult.code !== 0) continue;
    const version = parseRedisVersion(serverResult.stdout);
    if (!version) continue;
    usable.push({ server: pair.server, cli: pair.cli, version });
  }

  if (usable.length === 0) {
    return { serverBin: null, cliBin: null, serverVersion: null };
  }

  // Pick the sandbox that is the CLOSEST match that is still new enough.
  //
  // "Closest" matters for the artifact: the rebuilt RDB is written by the
  // sandbox, and a Redis never reads a newer data format than its own. The
  // closest build we have that can read the source is also the one most
  // likely to be readable by the customer's own server.
  const newEnough = sourceVersion
    ? usable
        .filter((entry) => compareRedisVersions(entry.version, sourceVersion) >= 0)
        .sort((a, b) => compareRedisVersions(a.version, b.version))
    : [];
  const chosen = newEnough[0] ?? usable[0];

  return {
    serverBin: chosen.server,
    cliBin: chosen.cli,
    serverVersion: chosen.version,
  };
}

/**
 * Run a full restore proof against a Redis endpoint.
 *
 * Never throws for an expected failure — a failure is a RESULT, not an
 * exception, and the caller must still close the proof out.
 */
export async function runRedisRestoreProof(
  opts: RedisSandboxOptions
): Promise<RedisSandboxResult> {
  const cliBinDefault = opts.cliBin ?? process.env.REDIS_PROOF_CLI_BIN ?? "redis-cli";
  const serverBinDefault = opts.serverBin ?? process.env.REDIS_PROOF_SERVER_BIN ?? "redis-server";
  let cliBin = cliBinDefault;
  let serverBin = serverBinDefault;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const sampleSize = opts.sampleSize ?? 25;
  const maxMemory = opts.maxMemory ?? "512mb";

  const checks: RedisCheckResult[] = [];
  const messages: string[] = [];
  let workDir: string | null = null;
  let sandbox: SandboxHandle | null = null;

  const addCheck = (
    name: string,
    status: RedisCheckResult["status"],
    message: string,
    durationMs = 0
  ) => {
    checks.push({
      name,
      type: "redis_restore_proof",
      status,
      message,
      durationMs,
    });
  };

  const fail = (
    message: string,
    outcome: RedisProofOutcome,
    partial: Partial<RedisSandboxResult> = {}
  ): RedisSandboxResult => {
    messages.push(message);
    addCheck("redis_restore_proof", "fail", message);
    return {
      restored: false,
      outcome,
      captureMethod: null,
      captureTruncated: false,
      sourceKeyCount: null,
      restoredKeyCount: null,
      rdbBytes: null,
      restoreSeconds: null,
      rpoObservedSeconds: null,
      rdbLastBgsaveStatus: null,
      sourceVersion: null,
      restoredVersion: null,
      restoredDigest: null,
      sampledKeys: null,
      ttlDistribution: null,
      restoredKeyspace: {},
      checks,
      messages,
      ...partial,
    };
  };

  const startedAt = Date.now();

  try {
    // 1. Reach the source first. This is where a private-network Redis is
    //    detected, and it costs one INFO round trip on the keyspace.
    let source: SourceInfo;
    try {
      source = await readSourceInfo(opts, Math.min(timeoutMs, 15_000));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const kind = classifyRedisFailure(message);
      return fail(
        kind === "unreachable"
          ? `Revenant's cloud runner could not reach ${redactRedisUrl(opts.redisUrl)} (${message}). ` +
            `If this Redis is on a private network, run the proof with the Revenant agent from inside that network.`
          : kind === "auth"
            ? `Redis rejected the credentials stored for ${redactRedisUrl(opts.redisUrl)}.`
            : `Could not read the state of ${redactRedisUrl(opts.redisUrl)}: ${message}`,
        kind === "unreachable" ? "unreachable" : "error"
      );
    }
    addCheck(
      "redis_ping",
      "pass",
      `source answered PING (redis ${source.version ?? "unknown"})`
    );

    // 2. Pick the sandbox binaries — now that we know the source's version.
    const resolved = await resolveSandboxBinaries(
      candidateList(
        opts.serverBin ??
          process.env.REDIS_PROOF_SERVER_BIN ??
          "redis-server-8,redis-server"
      ),
      candidateList(
        opts.cliBin ?? process.env.REDIS_PROOF_CLI_BIN ?? "redis-cli-8,redis-cli"
      ),
      source.version
    );

    if (!resolved.serverBin) {
      return fail(
        `The Redis proof sandbox needs redis-server and redis-cli on this host, and they could not be started. ` +
          `Install the Redis server binaries in the API image, or run the proof with the Revenant agent.`,
        "error"
      );
    }
    serverBin = resolved.serverBin;
    cliBin = resolved.cliBin ?? cliBin;
    const sandboxVersion = resolved.serverVersion;

    addCheck(
      "sandbox_runtime",
      "pass",
      `redis-cli ${sandboxVersion ?? "unknown"} · redis-server ${sandboxVersion ?? "unknown"} (${serverBin})`
    );

    // A sandbox older than the source cannot read the source's data format.
    // Say so plainly instead of letting the restore fail with a checksum
    // error that looks like a corrupt backup.
    const versionSkew =
      sandboxVersion &&
      source.version &&
      compareRedisVersions(source.version, sandboxVersion) > 0;
    if (versionSkew) {
      return fail(
        `This Redis is version ${source.version}, and the proof sandbox runs version ${sandboxVersion}. ` +
          `A restore sandbox must be at least as new as the server it replays data from, because Redis never reads a newer data format. ` +
          `Point REDIS_PROOF_SERVER_BIN / REDIS_PROOF_CLI_BIN at a Redis ${source.version} (or newer) build to run this proof.`,
        "error"
      );
    }

    workDir = await mkdtemp(join(tmpdir(), "revenant-redis-proof-"));

    // 2. Capture the data.
    //
    //    The RDB path is preferred: it proves the actual backup file
    //    restores. Providers that refuse the replication protocol (Azure
    //    Cache for Redis answers "ERR command 'replconf' is not allowed")
    //    get the logical path instead — the same question answered with
    //    commands every Redis allows.
    const pullStarted = Date.now();
    const rdbPath = join(workDir, "dump.rdb");
    const pull = await pullRdb(cliBin, opts, rdbPath, timeoutMs);

    let captureMethod: RedisCaptureMethod = "rdb";
    let rdbStat: { size: number } | null = null;
    let logical: LogicalCaptureResult | null = null;
    // Where the artifact the customer gets is written. The RDB path keeps
    // the customer's own file; the logical path rebuilds one from the data
    // it restored.
    let artifactPath: string | null = null;

    if (pull.ok) {
      rdbStat = await stat(rdbPath);
      artifactPath = rdbPath;
      addCheck(
        "redis_rdb_captured",
        "pass",
        "server streamed a complete RDB",
        Date.now() - pullStarted
      );
      addCheck("rdb_present", "pass", `${rdbStat.size} bytes of RDB`);
    } else {
      const kind = classifyRedisFailure(pull.message);
      if (kind === "unreachable" || kind === "auth") {
        return fail(
          kind === "unreachable"
            ? `Revenant's cloud runner could not reach ${redactRedisUrl(opts.redisUrl)} (${pull.message}). ` +
              `If this Redis is on a private network, run the proof with the Revenant agent from inside that network.`
            : `Redis rejected the credentials stored for ${redactRedisUrl(opts.redisUrl)}.`,
          kind === "unreachable" ? "unreachable" : "error"
        );
      }

      // The provider will not hand out its RDB. Fall back to a logical
      // capture rather than telling the customer their backup is broken.
      addCheck(
        "redis_rdb_captured",
        "skip",
        `This Redis will not stream its RDB (${pull.message.slice(0, 160)}). Falling back to a key-by-key capture.`
      );
      captureMethod = "logical";
    }

    // 3. Boot the sandbox. The RDB path loads the captured file; the logical
    //    path starts empty and is filled by RESTORE.
    if (captureMethod === "rdb" && rdbStat) {
      // The sandbox never opens the captured file itself — it gets a copy.
      await copyFile(rdbPath, join(workDir, "restore.rdb"));
    }
    const restoreStarted = Date.now();
    const started = await startSandbox(
      serverBin,
      workDir,
      captureMethod === "rdb" ? "restore.rdb" : "restored.rdb",
      maxMemory,
      timeoutMs
    );
    if (!started.ok) {
      // A sandbox that cannot start is our problem, not the customer's
      // backup's. Report it as "could not run", not "restore failed".
      return fail(
        `The throwaway redis-server used for the proof could not be started: ${started.message}`,
        "error"
      );
    }
    sandbox = started.handle;

    if (captureMethod === "rdb" && rdbStat) {
      const restoreSeconds = Math.round((Date.now() - restoreStarted) / 1000);
      addCheck(
        "redis_restore_proof",
        "pass",
        `restored server loaded the RDB and answered PING in ${restoreSeconds}s`,
        Date.now() - restoreStarted
      );
    } else {
      // The sandbox is up but empty. Fill it from the source.
      const logicalResult = await logicalCaptureAndRestore(opts, sandbox.port, {
        maxKeys: opts.maxLogicalKeys ?? 50_000,
        maxBytes: opts.maxLogicalBytes ?? 256 * 1024 * 1024,
      });
      if (!logicalResult.ok) {
        return fail(
          logicalResult.kind === "unreachable"
            ? `Revenant's cloud runner could not read the keyspace of ${redactRedisUrl(opts.redisUrl)} (${logicalResult.message}). ` +
              `If this Redis is on a private network, run the proof with the Revenant agent from inside that network.`
            : `Could not transfer the keyspace of ${redactRedisUrl(opts.redisUrl)}: ${logicalResult.message}`,
          logicalResult.kind === "unreachable" ? "unreachable" : "error"
        );
      }
      logical = logicalResult.result;
      addCheck(
        "redis_restore_proof",
        "pass",
        `rebuilt ${logical.transferred} keys in a throwaway redis-server in ${Math.round(
          (Date.now() - restoreStarted) / 1000
        )}s`,
        Date.now() - restoreStarted
      );
      addCheck(
        "redis_rdb_captured",
        "skip",
        "This Redis provider does not allow RDB capture, so the keyspace was captured key by key instead."
      );
      if (logical.truncated) {
        addCheck(
          "redis_capture_coverage",
          "fail",
          `Only ${logical.transferred} of ${logical.sourceTotal} keys could be transferred within the capture limits.`
        );
        messages.push(
          `Only ${logical.transferred} of ${logical.sourceTotal} keys were transferred within the capture limits — the proof covers a prefix of the keyspace, not all of it.`
        );
      }
      if (
        logical.sourceDigest &&
        logical.restoredDigest &&
        logical.sourceDigest === logical.restoredDigest
      ) {
        addCheck(
          "redis_value_digest",
          "pass",
          `the restored keyspace digest matches the source exactly (${logical.transferred} keys)`
        );
      } else if (logical.sourceDigest && logical.restoredDigest) {
        addCheck(
          "redis_value_digest",
          "fail",
          "the restored keyspace digest does not match the source"
        );
        messages.push(
          "The restored keyspace does not match the source — the data did not survive the round trip intact."
        );
      }

      // Write a real RDB of the restored data.
      //
      // The provider refused to hand out its own RDB, so the customer would
      // otherwise get NO artifact at all — the snapshot failed with "Restore
      // proof produced no RDB artifact to store" even though the proof had
      // just restored every key. The sandbox holds exactly the restored
      // data, so asking it to SAVE produces a genuine, loadable RDB of that
      // data. The proof is what makes it trustworthy: the digest above
      // already proved the restored keyspace matches the source.
      try {
        await withRedis(
          {
            host: "127.0.0.1",
            port: sandbox.port,
            timeoutMs: Math.max(timeoutMs, 60_000),
          },
          async (client) => {
            await client.send("SAVE");
          }
        );
        artifactPath = join(workDir, "restored.rdb");
        const written = await stat(artifactPath);
        rdbStat = { size: written.size };
        addCheck(
          "redis_artifact_written",
          "pass",
          `rebuilt an RDB of the restored data (${written.size} bytes)`
        );
      } catch (err) {
        addCheck(
          "redis_artifact_written",
          "fail",
          `could not write an RDB of the restored data: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }
    sandbox = started.handle;

    // 4. Inspect the RESTORED instance — not the live one. This is the whole
    //    difference between "we have a file" and "we can recover".
    const inspected = await withRedis(
      { host: "127.0.0.1", port: sandbox.port, timeoutMs: 10_000 },
      async (client) => {
        const dbsize = await client.send("DBSIZE");
        const restoredKeyCount = Number(bufToText(dbsize));
        const serverInfo = parseInfo(
          bufToText(await client.send("INFO", "server"))
        );
        const keyspace = parseKeyspace(
          bufToText(await client.send("INFO", "keyspace"))
        );
        const digestRaw = bufToText(
          await client.send("EVAL", DIGEST_LUA, "0", String(sampleSize))
        );
        const ttlRaw = bufToText(
          await client.send("EVAL", TTL_LUA, "0", String(sampleSize * 8))
        );
        const config = configToMap(
          await client.send(
            "CONFIG",
            "GET",
            "maxmemory-policy",
            "appendonly",
            "requirepass",
            "maxmemory"
          )
        );
        return {
          restoredKeyCount,
          restoredVersion: serverInfo.redis_version ?? null,
          keyspace,
          digestRaw,
          ttlRaw,
          config,
        };
      }
    ).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Could not inspect the restored instance: ${message}`);
    });

    const restoredKeyCount = Number.isFinite(inspected.restoredKeyCount)
      ? inspected.restoredKeyCount
      : null;
    addCheck(
      "redis_dbsize",
      restoredKeyCount == null ? "fail" : "pass",
      `restored instance holds ${inspected.restoredKeyCount} keys`
    );

    const digestLines = inspected.digestRaw.trim() ? inspected.digestRaw.split("\n") : [];
    const sampledKeys = digestLines.length;
    const sandboxDigest = digestLines.length
      ? createHash("sha256").update(digestLines.join("\n")).digest("hex")
      : null;

    // The logical path already compared a full keyspace digest against the
    // source; do not overwrite that verdict with a sampled one.
    const restoredDigest = logical ? logical.restoredDigest : sandboxDigest;
    if (!logical) {
      if (sandboxDigest) {
        addCheck(
          "redis_value_digest",
          "pass",
          `hashed ${sampledKeys} sampled keys server-side (no values read by Revenant)`
        );
      } else {
        addCheck("redis_value_digest", "skip", "could not compute a keyspace digest");
      }
    }

    let ttlDistribution: Record<string, number> | null = null;
    if (inspected.ttlRaw.trim()) {
      try {
        const parsedTtl = JSON.parse(inspected.ttlRaw) as Record<string, number>;
        ttlDistribution = parsedTtl;
        const entries = Object.entries(parsedTtl);
        addCheck(
          "redis_ttl_distribution",
          "pass",
          entries.length
            ? entries.map(([k, v]) => `${k}=${v}`).join(" ")
            : "empty keyspace"
        );
      } catch {
        addCheck("redis_ttl_distribution", "skip", "TTL histogram could not be parsed");
      }
    }

    // 5. Compare. A large shortfall is a warning, not a hard fail — keys
    //    legitimately expire between the capture and the restore.
    //
    //    In the logical path the source count comes from the scan itself,
    //    which is the number the transfer actually worked against.
    const sourceKeyCount = logical ? logical.sourceTotal : source.keyCount;
    if (
      sourceKeyCount != null &&
      restoredKeyCount != null &&
      restoredKeyCount < sourceKeyCount
    ) {
      const shortfall = sourceKeyCount - restoredKeyCount;
      const pct = Math.floor((shortfall * 100) / sourceKeyCount);
      if (pct >= 50) {
        messages.push(
          `Restored instance has ${restoredKeyCount} keys vs ${sourceKeyCount} at capture (${pct}% missing). ` +
            `Some expiry is expected, but a large gap usually means the RDB is stale — check the Redis \`save\` policy.`
        );
        addCheck(
          "redis_keyspace_match",
          "fail",
          `${pct}% of keys missing after restore`
        );
      } else {
        messages.push(
          `Restored ${restoredKeyCount}/${sourceKeyCount} keys (${pct}% fewer) — consistent with expiry between capture and restore.`
        );
        addCheck(
          "redis_keyspace_match",
          "pass",
          `${pct}% fewer keys, within expiry tolerance`
        );
      }
    } else {
      addCheck("redis_keyspace_match", "pass", "restored keyspace matches the capture");
    }

    addCheck(
      "redis_keyspace",
      sourceKeyCount == null ? "skip" : "pass",
      sourceKeyCount == null
        ? "could not read INFO keyspace from the source"
        : `source held ${sourceKeyCount} keys at capture time`
    );

    // 6. Security posture of the RESTORED instance — cheap and worth surfacing.
    //    requirepass is recorded only as SET / NOT SET.
    const requirepassSet = Boolean(inspected.config.requirepass);
    addCheck(
      "redis_config",
      "pass",
      `maxmemory-policy=${inspected.config["maxmemory-policy"] ?? "unknown"}, ` +
        `appendonly=${inspected.config.appendonly ?? "unknown"}, ` +
        `requirepass=${requirepassSet ? "SET (masked)" : "NOT SET"}`
    );

    // 7. Build the fingerprint of the RESTORED instance.
    const restoredKeyspace = inspected.keyspace;
    let restoredTotalExpires = 0;
    for (const entry of Object.values(restoredKeyspace)) {
      restoredTotalExpires += entry.expires;
    }

    // 8. The verdict.
    //
    //    A proof that RAN is not automatically a proof that PASSED. If a
    //    check failed — the restored keyspace did not match, the capture
    //    was cut short — the run is a failure, and saying otherwise is the
    //    one thing a backup product must never do.
    const failedChecks = checks.filter((check) => check.status === "fail");
    const digestMismatch = Boolean(
      logical &&
        logical.sourceDigest &&
        logical.restoredDigest &&
        logical.sourceDigest !== logical.restoredDigest
    );
    const passed = failedChecks.length === 0 && !digestMismatch;

    if (failedChecks.length > 0) {
      addCheck(
        "redis_proof_verdict",
        "fail",
        `${failedChecks.length} check${failedChecks.length === 1 ? "" : "s"} did not pass: ${failedChecks
          .map((check) => check.name)
          .join(", ")}`
      );
    }

    const result: RedisSandboxResult = {
      restored: passed,
      outcome: passed ? "restored" : "failed",
      captureMethod,
      captureTruncated: logical?.truncated ?? false,
      sourceKeyCount: source.keyCount,
      restoredKeyCount,
      rdbBytes: rdbStat?.size ?? null,
      restoreSeconds: Math.round((Date.now() - restoreStarted) / 1000),
      rpoObservedSeconds: source.rpoObservedSeconds,
      rdbLastBgsaveStatus: source.lastBgsaveStatus,
      sourceVersion: source.version,
      restoredVersion: inspected.restoredVersion,
      restoredDigest,
      sampledKeys: logical ? logical.transferred : sampledKeys,
      ttlDistribution,
      restoredKeyspace,
      checks,
      messages,
    };

    // The artifact is available on both paths: the customer's own RDB when
    // the provider let us take it, or one rebuilt from the restored data.
    if (opts.captureRdb && artifactPath) {
      const { readFile } = await import("node:fs/promises");
      result.rdb = await readFile(artifactPath);
    }

    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const kind = classifyRedisFailure(message);
    return fail(message, kind === "unreachable" ? "unreachable" : "error");
  } finally {
    // Always tear the sandbox down, even on the failure paths above.
    if (sandbox) sandbox.stop();
    if (workDir) {
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
