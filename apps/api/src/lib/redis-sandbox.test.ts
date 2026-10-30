import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  classifyRedisFailure,
  compareRedisVersions,
  parseRedisVersion,
  redactRedisUrl,
  runRedisRestoreProof,
} from "./redis-sandbox.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

async function binaryExists(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(bin, ["--version"], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error("no port"))));
    });
  });
}

interface SourceRedis {
  port: number;
  url: string;
  stop: () => void;
}

/** Boot a throwaway source Redis so the proof has something real to capture. */
async function startSourceRedis(
  options: { requirePassword?: string } = {}
): Promise<SourceRedis> {
  const port = await freePort();
  const dir = await mkdtemp(join(tmpdir(), "revenant-test-src-"));
  const args = [
    "--port",
    String(port),
    "--bind",
    "127.0.0.1",
    "--dir",
    dir,
    "--save",
    "",
    "--appendonly",
    "no",
  ];
  if (options.requirePassword) {
    args.push("--requirepass", options.requirePassword);
  }
  const child = spawn("redis-server", args, { stdio: "ignore" });

  const deadline = Date.now() + 15_000;
  for (;;) {
    const ok = await new Promise<boolean>((resolve) => {
      const probe = spawn(
        "redis-cli",
        ["-h", "127.0.0.1", "-p", String(port), "ping"],
        {
          stdio: "ignore",
          env: options.requirePassword
            ? { ...process.env, REDISCLI_AUTH: options.requirePassword }
            : process.env,
        }
      );
      probe.on("error", () => resolve(false));
      probe.on("close", (code) => resolve(code === 0));
    });
    if (ok) break;
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error("source redis did not start");
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  return {
    port,
    url: `redis://127.0.0.1:${port}/0`,
    stop: () => {
      child.kill("SIGKILL");
      void rm(dir, { recursive: true, force: true });
    },
  };
}

async function setKey(
  port: number,
  key: string,
  value: string,
  password?: string
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("redis-cli", ["-h", "127.0.0.1", "-p", String(port), "set", key, value], {
      stdio: "ignore",
      env: password ? { ...process.env, REDISCLI_AUTH: password } : process.env,
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`set ${key} failed`))
    );
  });
}

const hasBinaries =
  (await binaryExists("redis-server")) && (await binaryExists("redis-cli"));

/**
 * The AUTH path used to deadlock the RESP client, so a password-protected
 * Redis never answered at all. Prove it answers now.
 */
test(
  "talks to a password-protected Redis without deadlocking",
  { skip: hasBinaries ? false : "redis-server / redis-cli are not installed" },
  async () => {
    const source = await startSourceRedis({ requirePassword: "correct-horse" });
    try {
      await setKey(source.port, "secure:1", "value", "correct-horse");
      const result = await runRedisRestoreProof({
        redisUrl: `redis://:correct-horse@127.0.0.1:${source.port}/0`,
        timeoutMs: 30_000,
      });

      assert.equal(result.outcome, "restored");
      assert.equal(result.sourceKeyCount, 1);
      assert.equal(result.restoredKeyCount, 1);
    } finally {
      source.stop();
    }
  }
);

// ─── Unit: failure classification ───────────────────────────────────────────

test("a network failure is 'unreachable', not a broken backup", () => {
  assert.equal(
    classifyRedisFailure("connect ECONNREFUSED 10.0.0.4:6379"),
    "unreachable"
  );
  assert.equal(
    classifyRedisFailure("getaddrinfo ENOTFOUND cache.internal"),
    "unreachable"
  );
  assert.equal(classifyRedisFailure("Timed out connecting to redis"), "unreachable");
});

test("rejected credentials are 'auth' — the credentials, not the route", () => {
  assert.equal(classifyRedisFailure("NOAUTH Authentication required."), "auth");
  assert.equal(classifyRedisFailure("WRONGPASS invalid username-password pair"), "auth");
});

test("anything else is a genuine proof failure", () => {
  assert.equal(
    classifyRedisFailure("Can't handle RDB format version 12"),
    "failed"
  );
});

test("a redacted URL never carries the password", () => {
  const redacted = redactRedisUrl("redis://user:hunter2@cache.internal:6379/2");
  assert.ok(!redacted.includes("hunter2"));
  assert.ok(redacted.includes("cache.internal:6379"));
});

// ─── Integration: a real restore proof ──────────────────────────────────────

test(
  "restores a real RDB in a throwaway redis-server and compares keyspaces",
  { skip: hasBinaries ? false : "redis-server / redis-cli are not installed" },
  async () => {
    const source = await startSourceRedis();
    try {
      await setKey(source.port, "cart:1", '{"sku":"abc"}');
      await setKey(source.port, "cart:2", '{"sku":"def"}');
      await setKey(source.port, "session:9", "token");

      const result = await runRedisRestoreProof({
        redisUrl: source.url,
        timeoutMs: 60_000,
        sampleSize: 10,
      });

      assert.equal(result.outcome, "restored");
      assert.equal(result.restored, true);
      assert.equal(result.sourceKeyCount, 3);
      assert.equal(result.restoredKeyCount, 3);
      assert.ok((result.rdbBytes ?? 0) > 0, "expected a non-empty RDB");
      assert.ok(result.restoredDigest, "expected a keyspace digest");
      assert.ok((result.sampledKeys ?? 0) > 0, "expected sampled keys");
      assert.ok(result.ttlDistribution, "expected a TTL histogram");
      assert.ok(result.restoreSeconds !== null, "expected restore timing");
      assert.ok(result.sourceVersion, "expected the source version");

      const restoreCheck = result.checks.find((c) => c.name === "redis_restore_proof");
      assert.equal(restoreCheck?.status, "pass");
    } finally {
      source.stop();
    }
  }
);

test(
  "reports 'unreachable' when the Redis cannot be reached — it does not claim the backup is broken",
  { skip: hasBinaries ? false : "redis-server / redis-cli are not installed" },
  async () => {
    // A port nothing is listening on.
    const port = await freePort();
    const result = await runRedisRestoreProof({
      redisUrl: `redis://127.0.0.1:${port}/0`,
      timeoutMs: 20_000,
    });

    assert.equal(result.outcome, "unreachable");
    assert.equal(result.restored, false);
    assert.match(result.messages[0] ?? "", /could not reach/i);
  }
);

test(
  "reports rejected credentials as a credential problem, not an unreachable host",
  { skip: hasBinaries ? false : "redis-server / redis-cli are not installed" },
  async () => {
    const source = await startSourceRedis({ requirePassword: "correct-horse" });
    try {
      const result = await runRedisRestoreProof({
        redisUrl: `redis://:wrong-password@127.0.0.1:${source.port}/0`,
        timeoutMs: 20_000,
      });

      // "error", not "failed": the check could not run. Reporting a failed
      // CHECK as a failed BACKUP sends the customer hunting for a problem
      // they do not have.
      assert.equal(result.outcome, "error");
      assert.equal(result.restored, false);
      assert.match(result.messages[0] ?? "", /credential|authentication/i);
    } finally {
      source.stop();
    }
  }
);

test("compares Redis versions the way the data format does", () => {
  // A sandbox must be at least as new as the source. Redis never reads a
  // newer data format.
  assert.ok(compareRedisVersions("8.0.0", "7.9.9") > 0);
  assert.ok(compareRedisVersions("7.2.1", "7.2.0") > 0);
  assert.equal(compareRedisVersions("7.0.15", "7.0.15"), 0);
  assert.ok(compareRedisVersions("7.0.15", "8.0.0") < 0);
});

test("reads the version out of a redis-server banner", () => {
  assert.equal(
    parseRedisVersion(
      "Redis server v=7.0.15 sha=00000000:0 malloc=jemalloc-5.3.0 bits=64"
    ),
    "7.0.15"
  );
  assert.equal(
    parseRedisVersion("Redis server v=8.10.3 sha=00000000:1 malloc=jemalloc-5.3.0"),
    "8.10.3"
  );
});
