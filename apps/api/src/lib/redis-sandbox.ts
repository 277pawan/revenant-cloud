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
import { copyFile, mkdtemp, rm, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseRedisUrl, type RedisCheckResult } from "@revenant/shared";

import { bufToText, configToMap, parseInfo, parseKeyspace, withRedis } from "./redis-client.js";

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * How a proof ended.
 *
 * `unreachable` is the one that matters for routing: it means *this* executor
 * could not reach the customer's Redis, which is not proof that the backup is
 * broken. A private-network Redis is perfectly healthy — we just have no
 * route to it. The queue uses this to hand the run to another executor
 * (an agent inside the customer's VPC) instead of failing it.
 */
export type RedisProofOutcome = "restored" | "failed" | "unreachable";

export interface RedisSandboxOptions {
  /** redis:// or rediss://. Held in memory only; never logged in the clear. */
  redisUrl: string;
  /** Overall budget for the pull + boot + inspect sequence. */
  timeoutMs?: number;
  /** Keys sampled for the digest. */
  sampleSize?: number;
  /** Memory ceiling for the sandbox, so a large cache cannot OOM the host. */
  maxMemory?: string;
  /** Return the RDB bytes so the caller can store them (opt-in retention). */
  captureRdb?: boolean;
  /** Path to the redis-server binary. Defaults to "redis-server" on PATH. */
  serverBin?: string;
  /** Path to the redis-cli binary. Defaults to "redis-cli" on PATH. */
  cliBin?: string;
}

export interface RedisSandboxResult {
  /** Did the throwaway server actually boot from the RDB? */
  restored: boolean;
  outcome: RedisProofOutcome;
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
 * Run a full restore proof against a Redis endpoint.
 *
 * Never throws for an expected failure — a failure is a RESULT, not an
 * exception, and the caller must still close the proof out.
 */
export async function runRedisRestoreProof(
  opts: RedisSandboxOptions
): Promise<RedisSandboxResult> {
  const cliBin = opts.cliBin ?? process.env.REDIS_PROOF_CLI_BIN ?? "redis-cli";
  const serverBin =
    opts.serverBin ?? process.env.REDIS_PROOF_SERVER_BIN ?? "redis-server";
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
    kind: RedisFailureKind,
    partial: Partial<RedisSandboxResult> = {}
  ): RedisSandboxResult => {
    messages.push(message);
    addCheck("redis_restore_proof", "fail", message);
    return {
      restored: false,
      outcome: kind === "unreachable" ? "unreachable" : "failed",
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
    // 0. Preflight — the sandbox binaries must exist. Fail loudly and early
    //    rather than halfway through a proof.
    const [cliVersion, serverVersion] = await Promise.all([
      run(cliBin, ["--version"], { timeoutMs: 15_000 }).catch((err) => ({
        code: -1,
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
      })),
      run(serverBin, ["--version"], { timeoutMs: 15_000 }).catch((err) => ({
        code: -1,
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
      })),
    ]);

    if (cliVersion.code !== 0 || serverVersion.code !== 0) {
      const missing = [
        cliVersion.code !== 0 ? "redis-cli" : null,
        serverVersion.code !== 0 ? "redis-server" : null,
      ]
        .filter(Boolean)
        .join(" and ");
      return fail(
        `The Redis proof sandbox needs ${missing} on this host, and it could not be started. ` +
          `Install the Redis server binaries in the API image, or run the proof with the Revenant agent.`,
        "failed"
      );
    }
    addCheck(
      "sandbox_runtime",
      "pass",
      `${cliVersion.stdout.trim()} · ${serverVersion.stdout.trim()}`
    );

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
        kind
      );
    }
    addCheck(
      "redis_ping",
      "pass",
      `source answered PING (redis ${source.version ?? "unknown"})`
    );

    workDir = await mkdtemp(join(tmpdir(), "revenant-redis-proof-"));

    // 2. Pull the RDB off the live server (the server streams it to us).
    const pullStarted = Date.now();
    const rdbPath = join(workDir, "dump.rdb");
    const pull = await pullRdb(cliBin, opts, rdbPath, timeoutMs);
    if (!pull.ok) {
      const kind = classifyRedisFailure(pull.message);
      return fail(
        kind === "unreachable"
          ? `Revenant's cloud runner could not reach ${redactRedisUrl(opts.redisUrl)} (${pull.message}). ` +
            `If this Redis is on a private network, run the proof with the Revenant agent from inside that network.`
          : `Could not pull an RDB from ${redactRedisUrl(opts.redisUrl)}: ${pull.message}`,
        kind
      );
    }
    addCheck(
      "redis_rdb_captured",
      "pass",
      "server streamed a complete RDB",
      Date.now() - pullStarted
    );

    const rdbStat = await stat(rdbPath);
    addCheck("rdb_present", "pass", `${rdbStat.size} bytes of RDB`);

    // 3. Boot the sandbox against a COPY. The sandbox never opens the
    //    captured file itself.
    await copyFile(rdbPath, join(workDir, "restore.rdb"));
    const restoreStarted = Date.now();
    const started = await startSandbox(
      serverBin,
      workDir,
      "restore.rdb",
      maxMemory,
      timeoutMs
    );
    if (!started.ok) {
      // A sandbox that cannot load the dump is a REAL failure: the customer's
      // backup does not restore. That is the whole point of the proof.
      return fail(
        `The captured RDB did not restore in a throwaway redis-server: ${started.message}`,
        "failed",
        { rdbBytes: rdbStat.size }
      );
    }
    sandbox = started.handle;
    const restoreSeconds = Math.round((Date.now() - restoreStarted) / 1000);
    addCheck(
      "redis_restore_proof",
      "pass",
      `restored server loaded the RDB and answered PING in ${restoreSeconds}s`,
      Date.now() - restoreStarted
    );

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
    const restoredDigest = digestLines.length
      ? createHash("sha256").update(digestLines.join("\n")).digest("hex")
      : null;
    if (restoredDigest) {
      addCheck(
        "redis_value_digest",
        "pass",
        `hashed ${sampledKeys} sampled keys server-side (no values read by Revenant)`
      );
    } else {
      addCheck("redis_value_digest", "skip", "could not compute a keyspace digest");
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
    if (
      source.keyCount != null &&
      restoredKeyCount != null &&
      restoredKeyCount < source.keyCount
    ) {
      const shortfall = source.keyCount - restoredKeyCount;
      const pct = Math.floor((shortfall * 100) / source.keyCount);
      if (pct >= 50) {
        messages.push(
          `Restored instance has ${restoredKeyCount} keys vs ${source.keyCount} at capture (${pct}% missing). ` +
            `Some expiry is expected, but a large gap usually means the RDB is stale — check the Redis \`save\` policy.`
        );
        addCheck(
          "redis_keyspace_match",
          "fail",
          `${pct}% of keys missing after restore`
        );
      } else {
        messages.push(
          `Restored ${restoredKeyCount}/${source.keyCount} keys (${pct}% fewer) — consistent with expiry between capture and restore.`
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
      source.keyCount == null ? "skip" : "pass",
      source.keyCount == null
        ? "could not read INFO keyspace from the source"
        : `source held ${source.keyCount} keys at capture time`
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

    const result: RedisSandboxResult = {
      restored: true,
      outcome: "restored",
      sourceKeyCount: source.keyCount,
      restoredKeyCount,
      rdbBytes: rdbStat.size,
      restoreSeconds,
      rpoObservedSeconds: source.rpoObservedSeconds,
      rdbLastBgsaveStatus: source.lastBgsaveStatus,
      sourceVersion: source.version,
      restoredVersion: inspected.restoredVersion,
      restoredDigest,
      sampledKeys,
      ttlDistribution,
      restoredKeyspace,
      checks,
      messages,
    };

    if (opts.captureRdb) {
      const { readFile } = await import("node:fs/promises");
      result.rdb = await readFile(rdbPath);
    }

    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail(message, classifyRedisFailure(message));
  } finally {
    // Always tear the sandbox down, even on the failure paths above.
    if (sandbox) sandbox.stop();
    if (workDir) {
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
