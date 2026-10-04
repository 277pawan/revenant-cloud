import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAwsCliConfigYaml,
  buildCliEnv,
  buildDatabaseUrl,
  buildGitHubReleaseHeaders,
  buildReleaseAssetName,
  cliUnavailableOutcome,
  mapCliCleanupResult,
  mapCliCheckOutput,
  mapCliOutputProgress,
  mapCliReport,
  resolveConfiguredCliPath,
  type ClaimedPayload,
} from "./execute-job.js";
import { jobProgressSchema } from "../validations/jobs.schema.js";
import {
  assertAwsFullDrillSourceAvailable,
  type AwsSourceStatus,
} from "../services/aws-source-status.service.js";

test("missing AWS sources block full drills and direct users to retained recovery points", () => {
  const status: AwsSourceStatus = {
    state: "missing",
    rdsStatus: null,
    availableSnapshotCount: 2,
    latestSnapshotIdentifier: "retained-snapshot",
    latestSnapshotCreatedAt: null,
    checkedAt: new Date().toISOString(),
    message: "Source RDS instance was not found. 2 available snapshot(s) can still be used from Recovery Points.",
  };

  assert.throws(
    () => assertAwsFullDrillSourceAvailable(status),
    /full drill was not queued.*Recovery Points/
  );
});

test("CLI AWS lifecycle messages map to truthful job progress stages", () => {
  assert.equal(
    mapCliOutputProgress(
      "job=job-1 step=snapshot",
      "time=... level=INFO msg=\"creating RDS snapshot\""
    )?.stage,
    "creating_snapshot"
  );
  assert.equal(
    mapCliOutputProgress(
      "job=job-1 step=snapshot",
      "time=... level=INFO msg=\"RDS snapshot status\" status=creating"
    )?.stage,
    "waiting_for_snapshot"
  );
  assert.equal(
    mapCliOutputProgress(
      "job=job-1 step=verify",
      "time=... level=INFO msg=\"waiting for sandbox to become available\""
    )?.stage,
    "waiting_for_sandbox"
  );
  assert.equal(
    mapCliOutputProgress(
      "job=job-1 step=verify",
      "time=... level=INFO msg=\"destroying temporary RDS sandbox\""
    )?.stage,
    "cleaning_sandbox"
  );
});

test("CLI check output is streamed as completed source-check progress", () => {
  assert.deepEqual(
    mapCliCheckOutput("job=job-1 step=snapshot", "✓ customers table exists"),
    {
      checkName: "customers table exists",
      checkType: "source_validation",
      status: "pass",
      message: "customers table exists",
    }
  );
  assert.equal(
    mapCliCheckOutput("job=job-1 step=snapshot", "ordinary log output"),
    null
  );
});

test("runner progress accepts completed checks without changing stage payloads", () => {
  assert.equal(
    jobProgressSchema.safeParse({
      stage: "selecting_snapshot",
      message: "Snapshot is ready.",
      checks: [{
        checkName: "snapshot",
        checkType: "snapshot",
        status: "pass",
        message: "Snapshot created",
      }],
    }).success,
    true
  );
  assert.equal(
    jobProgressSchema.safeParse({
      stage: "selecting_snapshot",
      message: "Snapshot is ready.",
      checks: [{
        checkName: "snapshot",
        checkType: "snapshot",
        status: "running",
        message: "Snapshot creation",
      }],
    }).success,
    false
  );
});

test("snapshot report preserves every source validation check for the job details", () => {
  const checks = mapCliReport({
    status: "FAIL",
    checks: [
      { name: "connect", status: "PASS", message: "database connection OK" },
      { name: "orders:row_count", status: "FAIL", message: "row count 5 < min 10" },
    ],
  }, "source_validation");

  assert.deepEqual(
    checks.map(({ checkName, checkType, status, message }) => ({
      checkName,
      checkType,
      status,
      message,
    })),
    [
      {
        checkName: "connect",
        checkType: "source_validation",
        status: "pass",
        message: "database connection OK",
      },
      {
        checkName: "orders:row_count",
        checkType: "source_validation",
        status: "fail",
        message: "row count 5 < min 10",
      },
    ]
  );
});

test("verify failure without report details surfaces the actual CLI output", () => {
  const cliOutput = "connect to sandbox: TLS handshake failed";
  const results = mapCliReport({}, undefined, cliOutput);
  assert.equal(results[0]?.message, cliOutput);
});

test("Cloud GitHub token is separate from selected database credentials", () => {
  const previousToken = process.env.REVENANT_CLI_GITHUB_TOKEN;
  process.env.REVENANT_CLI_GITHUB_TOKEN = "internal-download-token";
  try {
    const result = buildCliEnv({
      job: { id: "job-1", databaseName: "selected-db" },
      database: {
        id: "db-1",
        engine: "postgres",
        host: "selected-db.example",
        port: 5432,
        databaseName: "app",
        username: "app-user",
        sslMode: "require",
        recoveryMode: "direct",
      },
      password: "selected:db@password",
      recovery: null,
      awsCredentials: null,
      planYaml: "checks:\n  - type: connect",
    }, false);

    assert.equal(
      result.env.DATABASE_URL,
      "postgresql://app-user:selected%3Adb%40password@selected-db.example:5432/app?sslmode=require"
    );
    assert.equal(result.env.REVENANT_CLI_GITHUB_TOKEN, undefined);
  } finally {
    if (previousToken === undefined) delete process.env.REVENANT_CLI_GITHUB_TOKEN;
    else process.env.REVENANT_CLI_GITHUB_TOKEN = previousToken;
  }
});

test("AWS drill uses the selected database's sandbox and AWS credentials", () => {
  const previousToken = process.env.REVENANT_CLI_GITHUB_TOKEN;
  process.env.REVENANT_CLI_GITHUB_TOKEN = "internal-download-token";
  try {
    const result = buildCliEnv({
      job: { id: "job-aws", databaseName: "selected-production-db" },
      database: {
        id: "db-aws",
        engine: "postgres",
        host: "selected-production-db.example",
        port: 5432,
        databaseName: "selected_app",
        username: "selected_master",
        sslMode: "require",
        recoveryMode: "aws-rds",
      },
      password: "selected-master-password",
      recovery: {
        engine: "aws-rds",
        sourceIdentifier: "selected-source-rds",
        region: "eu-west-2",
        useFreetier: false,
        sandboxInstanceClass: "db.t3.micro",
        maxLifetimeMinutes: 60,
        cleanupCustomerSnapshots: false,
      },
      awsCredentials: {
        accessKeyId: "SELECTED_ACCESS_KEY",
        secretAccessKey: "selected-secret-key",
        sessionToken: "selected-session-token",
      },
      planYaml: "checks:\n  - type: connect",
    }, true);

    assert.equal(result.env.AWS_ACCESS_KEY_ID, "SELECTED_ACCESS_KEY");
    assert.equal(result.env.AWS_SECRET_ACCESS_KEY, "selected-secret-key");
    assert.equal(result.env.AWS_SESSION_TOKEN, "selected-session-token");
    assert.equal(result.env.AWS_REGION, "eu-west-2");
    assert.equal(result.env.SANDBOX_USER, "selected_master");
    assert.equal(result.env.SANDBOX_PASSWORD, "selected-master-password");
    assert.equal(result.env.SANDBOX_DBNAME, "selected_app");
    assert.equal(result.env.REVENANT_CLI_GITHUB_TOKEN, undefined);
  } finally {
    if (previousToken === undefined) delete process.env.REVENANT_CLI_GITHUB_TOKEN;
    else process.env.REVENANT_CLI_GITHUB_TOKEN = previousToken;
  }
});

test("AWS MySQL drills build a MySQL source URL and sandbox config", () => {
  const claimed: ClaimedPayload = {
    job: { id: "job-mysql", databaseName: "Production Mysql" },
    database: {
      id: "db-mysql",
      engine: "mysql",
      host: "mysql.example",
      port: 3306,
      databaseName: "myapp",
      username: "admin",
      sslMode: "require",
      recoveryMode: "aws-rds",
    },
    password: "mysql-secret",
    recovery: {
      engine: "aws-rds",
      sourceIdentifier: "mysql-database-1",
      region: "eu-west-2",
      useFreetier: true,
      sandboxInstanceClass: "db.t3.micro",
      maxLifetimeMinutes: 60,
      cleanupCustomerSnapshots: false,
    },
    awsCredentials: {
      accessKeyId: "AKIAEXAMPLE",
      secretAccessKey: "aws-secret",
      sessionToken: "aws-session-token",
    },
    planYaml: "checks:\n  - type: connect",
  };
  const { env } = buildCliEnv(claimed, true);
  assert.equal(
    env.SOURCE_DATABASE_URL,
    "mysql://admin:mysql-secret@mysql.example:3306/myapp?tls=skip-verify"
  );
  assert.equal(
    env.DATABASE_URL,
    "mysql://admin:mysql-secret@mysql.example:3306/myapp?tls=skip-verify"
  );
  assert.equal(
    buildDatabaseUrl({
      ...claimed,
      database: { ...claimed.database, sslMode: "prefer" },
    }),
    "mysql://admin:mysql-secret@mysql.example:3306/myapp?tls=preferred"
  );
  assert.equal(
    buildDatabaseUrl({
      ...claimed,
      database: { ...claimed.database, sslMode: "disable" },
    }),
    "mysql://admin:mysql-secret@mysql.example:3306/myapp"
  );
  assert.equal(env.AWS_SESSION_TOKEN, "aws-session-token");

  const yaml = buildAwsCliConfigYaml(
    claimed.planYaml,
    claimed.job.databaseName,
    claimed.recovery!,
    claimed.database.id,
    claimed.job.id,
    claimed.database.engine,
    claimed.database.sslMode
  );
  assert.match(yaml, /engine: mysql/);
  assert.match(
    yaml,
    /connection: mysql:\/\/\$\{SANDBOX_USER\}:\$\{SANDBOX_PASSWORD\}@\$\{SANDBOX_ENDPOINT\}:3306\/\$\{SANDBOX_DBNAME\}\?tls=skip-verify/
  );
  assert.match(yaml, /source_connection: \$\{SOURCE_DATABASE_URL\}/);
  assert.doesNotMatch(yaml, /postgres/);
});

test("private release authorization is attached only to GitHub API requests", () => {
  assert.deepEqual(
    buildGitHubReleaseHeaders("application/vnd.github+json", "internal-token"),
    {
      Accept: "application/vnd.github+json",
      Authorization: "Bearer internal-token",
    }
  );
  assert.deepEqual(buildGitHubReleaseHeaders("application/json", " "), {
    Accept: "application/json",
  });
});

test("unavailable CLI produces a failed result, not a metadata pass", () => {
  const outcome = cliUnavailableOutcome("stub", "private release was unavailable");
  assert.equal(outcome.status, "fail");
  assert.equal(outcome.usedCli, false);
  assert.equal(outcome.results[0]?.status, "fail");
  assert.match(outcome.errorMessage ?? "", /Managed validation did not run/);
});

test("AWS verify config carries database and job ids for RDS resource tags", () => {
  const yaml = buildAwsCliConfigYaml(
    "checks:\n  - type: connect",
    "production",
    {
      engine: "aws-rds",
      sourceIdentifier: "prod-db",
      region: "us-east-1",
      snapshotIdentifier: "the-selected-snapshot",
      useFreetier: false,
      sandboxInstanceClass: null,
      maxLifetimeMinutes: 60,
      cleanupCustomerSnapshots: false,
    },
    "database-123",
    "job-456"
  );

  assert.match(yaml, /database_id: "database-123"/);
  assert.match(yaml, /run_id: "job-456"/);
  assert.match(yaml, /snapshot_identifier: "the-selected-snapshot"/);
  assert.match(yaml, /max_lifetime_minutes: 60/);
  assert.match(
    yaml,
    /connection: postgres:\/\/\$\{SANDBOX_USER\}:\$\{SANDBOX_PASSWORD\}@\$\{SANDBOX_ENDPOINT\}:5432\/\$\{SANDBOX_DBNAME\}\?sslmode=require/
  );
});

test("AWS recovery config can explicitly retain resources without an expiry tag", () => {
  const yaml = buildAwsCliConfigYaml(
    "checks:\n  - type: connect",
    "production",
    {
      engine: "aws-rds",
      sourceIdentifier: "prod-db",
      region: "us-east-1",
      useFreetier: false,
      sandboxInstanceClass: null,
      maxLifetimeMinutes: null,
      cleanupCustomerSnapshots: false,
    },
    "database-123",
    "job-456"
  );

  assert.match(yaml, /retain_resources: true/);
  assert.doesNotMatch(yaml, /max_lifetime_minutes:/);
});

test("cleanup failure is represented separately from verification", () => {
  const cleanup = mapCliCleanupResult({
    temporary_instance_identifier: "revenant-temp-123",
    cleanup_status: "CLEANUP_FAILED",
    cleanup_error: "AccessDenied",
  });

  assert.equal(cleanup.checkType, "cleanup");
  assert.equal(cleanup.status, "fail");
  assert.match(cleanup.message, /revenant-temp-123/);
  assert.match(cleanup.message, /AccessDenied/);
});

test("verified temporary-instance deletion is reported as successful cleanup", () => {
  const cleanup = mapCliCleanupResult({
    temporary_instance_identifier: "revenant-temp-123",
    cleanup_status: "CLEANED",
  });

  assert.equal(cleanup.status, "pass");
  assert.match(cleanup.message, /cleaned/);
});

test("buildReleaseAssetName creates the release asset name used by GitHub Releases", () => {
  const asset = buildReleaseAssetName("v0.1.1");
  assert.ok(asset);
  assert.match(asset!, /^revenant_0\.1\.1_/);
  assert.ok(asset!.endsWith(".tar.gz") || asset!.endsWith(".zip"));
});

test("only an explicitly configured existing CLI path is accepted", async () => {
  assert.equal(await resolveConfiguredCliPath(process.execPath), process.execPath);
  assert.equal(await resolveConfiguredCliPath("/missing/revenant"), null);
  assert.equal(await resolveConfiguredCliPath(""), null);
});
