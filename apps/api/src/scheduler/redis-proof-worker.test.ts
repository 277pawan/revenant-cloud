import assert from "node:assert/strict";
import test from "node:test";

import {
  decideProofDisposition,
  toFingerprint,
} from "./redis-proof-worker.js";
import type { RedisSandboxResult } from "../lib/redis-sandbox.js";

function result(overrides: Partial<RedisSandboxResult> = {}): RedisSandboxResult {
  return {
    restored: false,
    outcome: "failed",
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
    checks: [],
    messages: [],
    ...overrides,
  };
}

test("an unreachable Redis releases the proof instead of failing it", () => {
  // The backup was never tested. Failing the run would tell the customer
  // their backup is broken when all we know is that we have no route to it.
  assert.equal(
    decideProofDisposition(result({ outcome: "unreachable" })),
    "release"
  );
});

test("a proof that ran always completes, pass or fail", () => {
  assert.equal(
    decideProofDisposition(result({ outcome: "restored", restored: true })),
    "complete"
  );
  assert.equal(
    decideProofDisposition(result({ outcome: "failed", restored: false })),
    "complete"
  );
});

test("the stored fingerprint carries digests only — never keys or values", () => {
  const fingerprint = toFingerprint(
    result({
      outcome: "restored",
      restored: true,
      restoredVersion: "7.0.15",
      restoredDigest: "abc123",
      sampledKeys: 25,
    }),
    { db0: { keys: 42, expires: 7, avgTtl: null } }
  );

  assert.equal(fingerprint.source, "restored_rdb");
  assert.equal(fingerprint.totalKeys, 42);
  assert.equal(fingerprint.totalExpires, 7);
  assert.equal(fingerprint.sampleDigest, "abc123");
  assert.equal(fingerprint.sampledKeys, 25);
  assert.equal(fingerprint.requirepass, "NOT SET");
  assert.ok(!JSON.stringify(fingerprint).includes("hunter2"));
});
