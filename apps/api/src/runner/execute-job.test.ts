import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAwsCliConfigYaml,
  buildReleaseAssetName,
  isLocalCliOverrideAllowed,
  mapCliCleanupResult,
} from "./execute-job.js";

test("AWS verify config carries database and job ids for RDS resource tags", () => {
  const yaml = buildAwsCliConfigYaml(
    "checks:\n  - type: connect",
    "production",
    { engine: "aws-rds", sourceIdentifier: "prod-db", region: "us-east-1" },
    "database-123",
    "job-456"
  );

  assert.match(yaml, /database_id: "database-123"/);
  assert.match(yaml, /job_id: "job-456"/);
});

test("cleanup failure is represented separately from verification", () => {
  const cleanup = mapCliCleanupResult({
    temporary_instance_identifier: "revenant-temp-123",
    cleanup_status: "failed",
    cleanup_error: "AccessDenied",
  });

  assert.equal(cleanup.checkType, "cleanup");
  assert.equal(cleanup.status, "fail");
  assert.match(cleanup.message, /revenant-temp-123/);
  assert.match(cleanup.message, /AccessDenied/);
});

test("buildReleaseAssetName creates the release asset name used by GitHub Releases", () => {
  const asset = buildReleaseAssetName("v0.1.1");
  assert.ok(asset);
  assert.match(asset!, /^revenant_0\.1\.1_/);
  assert.ok(asset!.endsWith(".tar.gz") || asset!.endsWith(".zip"));
});

test("local CLI override is blocked unless explicitly allowed", () => {
  const prevCli = process.env.REVENANT_CLI_PATH;
  const prevAllow = process.env.REVENANT_ALLOW_LOCAL_FALLBACK;

  try {
    process.env.REVENANT_CLI_PATH = "/tmp/revenant-local";
    delete process.env.REVENANT_ALLOW_LOCAL_FALLBACK;
    assert.equal(isLocalCliOverrideAllowed(), false);

    process.env.REVENANT_ALLOW_LOCAL_FALLBACK = "true";
    assert.equal(isLocalCliOverrideAllowed(), true);
  } finally {
    if (prevCli === undefined) delete process.env.REVENANT_CLI_PATH;
    else process.env.REVENANT_CLI_PATH = prevCli;

    if (prevAllow === undefined) delete process.env.REVENANT_ALLOW_LOCAL_FALLBACK;
    else process.env.REVENANT_ALLOW_LOCAL_FALLBACK = prevAllow;
  }
});
