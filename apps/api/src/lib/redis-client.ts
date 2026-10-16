/**
 * Minimal RESP (Redis serialization protocol) client.
 *
 * Why hand-rolled instead of `ioredis` or `node-redis`:
 *   - We only need ~8 read-only commands plus AUTH/SELECT.
 *   - The API's job is to *test a customer's Redis URL* and fingerprint it.
 *     That path must not drag a connection pool, a retry strategy, and a
 *     reconnect loop into every API container.
 *   - Fewer dependencies in the credential-handling path is a security win.
 *
 * Deliberate limits of this client — do not use it as a general Redis driver:
 *   - No pipelining, no transactions, no Pub/Sub.
 *   - No automatic reconnect.
 *   - Always pair with `close()` (use `withRedis()`).
 *
 * SAFETY: this module never logs a command argument that could be a secret,
 * and the fingerprint it builds contains digests only — never raw keys or
 * values. See packages/shared/src/redis.ts.
 */
import { createHash } from "node:crypto";
import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";

import {
  type RedisFingerprint,
} from "@revenant/shared";

const DEFAULT_TIMEOUT_MS = 5_000;

// ─── RESP value model ───────────────────────────────────────────────────────

/** Bulk strings parse to Buffer because DUMP payloads are binary. */
export type RespValue = Buffer | number | RespValue[] | null | RespError;

export class RespError extends Error {
  constructor(readonly prefix: string) {
    super(`Redis error: ${prefix}`);
    this.name = "RespError";
  }
}

function bufToText(value: RespValue | undefined): string {
  if (value == null) return "";
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  if (typeof value === "number") return String(value);
  if (value instanceof RespError) throw value;
  if (Array.isArray(value)) return value.map(bufToText).join(" ");
  return "";
}

// ─── Encoder ────────────────────────────────────────────────────────────────

function encodeCommand(args: readonly string[]): Buffer {
  const parts: Buffer[] = [Buffer.from(`*${args.length}\r\n`, "utf8")];
  for (const arg of args) {
    const buf = Buffer.from(arg, "utf8");
    parts.push(Buffer.from(`$${buf.length}\r\n`, "utf8"));
    parts.push(buf, Buffer.from("\r\n", "utf8"));
  }
  return Buffer.concat(parts);
}

// ─── Parser ─────────────────────────────────────────────────────────────────

/**
 * Incremental RESP parser. Feed it socket chunks; it returns the number of
 * bytes consumed and the parsed value, or null when the reply is incomplete.
 */
export function parseResp(
  buf: Buffer,
  offset = 0
): { value: RespValue; consumed: number } | null {
  if (offset >= buf.length) return null;

  const type = buf[offset];
  const lineEnd = buf.indexOf("\r\n", offset, "utf8");
  if (lineEnd === -1) return null;
  const line = buf.toString("utf8", offset + 1, lineEnd);
  const afterLine = lineEnd + 2;

  switch (type) {
    case 0x2b: // '+' simple string
      return { value: Buffer.from(line, "utf8"), consumed: afterLine - offset };

    case 0x2d: // '-' error
      return { value: new RespError(line), consumed: afterLine - offset };

    case 0x3a: // ':' integer
      return { value: Number.parseInt(line, 10), consumed: afterLine - offset };

    case 0x24: {
      // '$' bulk string
      const len = Number.parseInt(line, 10);
      if (len === -1) return { value: null, consumed: afterLine - offset };
      const start = afterLine;
      const end = start + len;
      if (buf.length < end + 2) return null;
      return { value: buf.subarray(start, end), consumed: end + 2 - offset };
    }

    case 0x2a: {
      // '*' array
      const count = Number.parseInt(line, 10);
      if (count === -1) return { value: null, consumed: afterLine - offset };
      const values: RespValue[] = [];
      let cursor = afterLine;
      for (let i = 0; i < count; i++) {
        const parsed = parseResp(buf, cursor);
        if (!parsed) return null;
        values.push(parsed.value);
        cursor += parsed.consumed;
      }
      return { value: values, consumed: cursor - offset };
    }

    default:
      // Inline or unknown — treat the line as text so we never hang.
      return { value: Buffer.from(line, "utf8"), consumed: afterLine - offset };
  }
}

// ─── Client ─────────────────────────────────────────────────────────────────

export interface RedisConnectOptions {
  host: string;
  port: number;
  username?: string | null;
  password?: string | null;
  dbIndex?: number;
  tls?: boolean;
  timeoutMs?: number;
  /** Caller-supplied cancellation (e.g. Fastify request aborted) */
  signal?: AbortSignal;
}

export class RedisProbe {
  private buffer: Buffer = Buffer.alloc(0);
  private pending: Array<{ resolve: (v: RespValue) => void; reject: (e: Error) => void }> = [];
  private queue: string[][] = [];
  private closed = false;

  private constructor(private readonly socket: Socket | TLSSocket) {}

  static async open(opts: RedisConnectOptions): Promise<RedisProbe> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const socket = opts.tls
      ? tlsConnect({ host: opts.host, port: opts.port, servername: opts.host })
      : netConnect({ host: opts.host, port: opts.port });

    const probe = new RedisProbe(socket);
    socket.on("data", (chunk) => probe.#onData(chunk));
    socket.on("error", (err) => probe.#fail(err));
    socket.on("close", () => probe.#fail(new Error("Redis connection closed")));

    await probe.#withTimeout(
      new Promise<void>((resolve, reject) => {
        socket.once(opts.tls ? "secureConnect" : "connect", resolve);
        socket.once("error", reject);
      }),
      timeoutMs,
      `Timed out connecting to redis://${opts.host}:${opts.port}`
    );

    try {
      // Redis 6+ prefers ACL AUTH <user> <pass>; Redis 5 and older only
      // accept AUTH <pass>. Try the modern form, fall back on failure.
      if (opts.password) {
        try {
          await probe.send("AUTH", opts.username as string, opts.password);
        } catch {
          await probe.send("AUTH", opts.password);
        }
      } else if (opts.username) {
        // ACL user without a password — still needs the ACL form.
        await probe.send("AUTH", opts.username, "");
      }
      const db = opts.dbIndex ?? 0;
      if (db > 0) await probe.send("SELECT", String(db));
    } catch (err) {
      probe.close();
      throw err;
    }

    return probe;
  }

  #onData(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    // Drain as many complete replies as the buffer holds.
    for (;;) {
      const parsed = parseResp(this.buffer, 0);
      if (!parsed) break;
      this.buffer = this.buffer.subarray(parsed.consumed);
      const waiter = this.pending.shift();
      if (waiter) waiter.resolve(parsed.value);
    }
  }

  #fail(err: Error): void {
    if (this.closed) return;
    this.closed = true;
    const waiters = this.pending.splice(0);
    for (const w of waiters) w.reject(err);
  }

  #withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.close();
        reject(new Error(message));
      }, ms);
      this.socket.once("close", () => clearTimeout(timer));
      p.then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (e) => {
          clearTimeout(timer);
          reject(e);
        }
      );
    });
  }

  send(...args: string[]): Promise<RespValue> {
    if (this.closed) return Promise.reject(new Error("Redis connection closed"));
    return new Promise<RespValue>((resolve, reject) => {
      this.pending.push({ resolve, reject });
      this.socket.write(encodeCommand(args), (err) => {
        if (err) {
          this.closed = true;
          reject(err);
        }
      });
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.destroy();
  }
}

/** Open, use, always close. */
export async function withRedis<T>(
  opts: RedisConnectOptions,
  fn: (client: RedisProbe) => Promise<T>
): Promise<T> {
  const client = await RedisProbe.open(opts);
  try {
    return await fn(client);
  } finally {
    client.close();
  }
}

// ─── INFO parsing ───────────────────────────────────────────────────────────

/** Parse `INFO` output ("key:value\r\n" lines) into a flat map. */
export function parseInfo(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return out;
}

/**
 * Parse the `keyspace` section: "db0:keys=42,expires=7,avg_ttl=0".
 */
export function parseKeyspace(info: Record<string, string>): RedisFingerprint["keyspace"] {
  const out: RedisFingerprint["keyspace"] = {};
  const raw = info.keyspace;
  if (!raw) return out;
  for (const entry of raw.split(/\r?\n/)) {
    const m = /^db(\d+):keys=(\d+),expires=(\d+)(?:,avg_ttl=(\d+))?$/.exec(entry.trim());
    if (!m) continue;
    out[`db${m[1]}`] = {
      keys: Number(m[2]),
      expires: Number(m[3]),
      avgTtl: m[4] ? Number(m[4]) : null,
    };
  }
  return out;
}

// ─── Fingerprint ────────────────────────────────────────────────────────────

export interface FingerprintOptions {
  /**
   * Sample keys and digest their values. OFF by default.
   *
   * The API only needs a connectivity + config fingerprint to answer "can we
   * reach this Redis". Sampling reads real key names into memory, so it is
   * reserved for the agent, which runs inside the customer's own network.
   */
  includeSamples?: boolean;
  sampleSize?: number;
}

export async function fingerprintRedis(
  client: RedisProbe,
  opts: FingerprintOptions = {}
): Promise<RedisFingerprint> {
  const info = parseInfo(bufToText(await client.send("INFO", "server")));
  const persistence = parseInfo(bufToText(await client.send("INFO", "persistence")));
  const keyspace = parseKeyspace(parseInfo(bufToText(await client.send("INFO", "keyspace"))));

  const configReply = await client.send("CONFIG", "GET", "maxmemory-policy", "maxmemory", "appendonly", "save", "requirepass");
  const config = configToMap(configReply);

  let totalKeys = 0;
  let totalExpires = 0;
  for (const entry of Object.values(keyspace)) {
    totalKeys += entry.keys;
    totalExpires += entry.expires;
  }

  let sampleDigest: string | null = null;
  let sampledKeys = 0;
  if (opts.includeSamples) {
    const { digest, count } = await sampleKeyspaceDigest(client, opts.sampleSize ?? 25);
    sampleDigest = digest;
    sampledKeys = count;
  }

  return {
    source: "live",
    version: info.redis_version ?? null,
    mode: info.redis_mode ?? null,
    keyspace,
    totalKeys,
    totalExpires,
    usedMemoryBytes: info.used_memory ? Number(info.used_memory) : null,
    maxmemoryBytes: config.maxmemory ? Number(config.maxmemory) : null,
    maxmemoryPolicy: config["maxmemory-policy"] ?? null,
    // Record only WHETHER a password is set. The value never leaves the agent.
    requirepass: config.requirepass ? "SET" : "NOT SET",
    appendOnly: config.appendonly === "yes" ? "yes" : config.appendonly === "no" ? "no" : null,
    savePolicy: config.save ?? null,
    sampleDigest,
    sampledKeys,
    capturedAt: new Date().toISOString(),
  };
}

/** CONFIG GET returns a flat [k, v, k, v] array. */
function configToMap(reply: RespValue): Record<string, string> {
  const out: Record<string, string> = {};
  if (!Array.isArray(reply)) return out;
  for (let i = 0; i + 1 < reply.length; i += 2) {
    out[bufToText(reply[i]).toLowerCase()] = bufToText(reply[i + 1]);
  }
  return out;
}

/**
 * Walk the keyspace with SCAN and hash what we find.
 *
 * The key NAME is hashed before it is used in the digest, so the resulting
 * fingerprint cannot be reversed into a key listing even if the digest leaks.
 * Values are hashed via their DUMP payload (binary-safe, covers any type).
 */
async function sampleKeyspaceDigest(
  client: RedisProbe,
  sampleSize: number
): Promise<{ digest: string; count: number }> {
  const collected: string[] = [];
  let cursor = "0";

  do {
    const reply = await client.send("SCAN", cursor, "COUNT", "200");
    if (!Array.isArray(reply)) break;
    cursor = bufToText(reply[0]) || "0";
    const keys = Array.isArray(reply[1]) ? reply[1] : [];
    for (const rawKey of keys) {
      if (collected.length >= sampleSize) break;
      const keyBuf = Buffer.isBuffer(rawKey) ? rawKey : Buffer.from(bufToText(rawKey), "utf8");
      const dumped = await client.send("DUMP", keyBuf.toString("binary"));
      const payload = Buffer.isBuffer(dumped) ? dumped : Buffer.alloc(0);
      collected.push(
        `${createHash("sha256").update(keyBuf).digest("hex")}:` +
          `${createHash("sha256").update(payload).digest("hex")}`
      );
    }
  } while (cursor !== "0" && collected.length < sampleSize);

  collected.sort();
  return {
    digest: createHash("sha256").update(collected.join("\n")).digest("hex"),
    count: collected.length,
  };
}

/** Exposed for tests. */
export const __internal = { encodeCommand, configToMap, bufToText };