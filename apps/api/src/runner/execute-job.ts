import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { access, constants } from "node:fs/promises";
import type { AwsRecoveryConfig, RecoveryMode, RunnerAwsCredentials } from "@revenant/shared";

export type ClaimedPayload = {
  job: { id: string; databaseName: string };
  database: {
    host: string | null;
    port: number | null;
    databaseName: string | null;
    username: string | null;
    sslMode?: string | null;
    recoveryMode?: RecoveryMode;
  };
  password: string | null;
  recovery: AwsRecoveryConfig | null;
  awsCredentials: RunnerAwsCredentials | null;
  planYaml: string | null;
  fullDrill?: boolean;
};

export type CheckResult = {
  checkName: string;
  checkType: string;
  status: "pass" | "fail" | "skip" | "error";
  message: string;
  durationMs: number;
};

export type ExecutionOutcome = {
  status: "pass" | "fail";
  executionMode: "stub" | "agent" | "ci";
  results: CheckResult[];
  errorMessage?: string;
  rtoSeconds: number;
  usedCli: boolean;
};

type CliReport = {
  status?: string;
  checks?: Array<{ name?: string; status?: string; message?: string }>;
};

const AWS_VERIFY_TIMEOUT_MS = Number(
  process.env.REVENANT_AWS_VERIFY_TIMEOUT_MS ?? 2_100_000
);
const DIRECT_VERIFY_TIMEOUT_MS = Number(
  process.env.REVENANT_VERIFY_TIMEOUT_MS ?? 120_000
);

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolve revenant binary: env → PATH → sibling repo binary */
export async function resolveRevenantCli(): Promise<string | null> {
  const fromEnv = process.env.REVENANT_CLI_PATH?.trim();
  if (fromEnv && (await fileExists(fromEnv))) {
    return fromEnv;
  }

  const sibling = resolve(
    process.cwd(),
    "..",
    "..",
    "..",
    "revenant-cli",
    "revenant"
  );
  const candidates = [
    fromEnv,
    sibling,
    resolve(process.cwd(), "../revenant-cli/revenant"),
    resolve(process.cwd(), "../../revenant-cli/revenant"),
    resolve(process.cwd(), "revenant"),
  ].filter(Boolean) as string[];

  for (const c of candidates) {
    if (await fileExists(c)) return c;
  }

  try {
    await new Promise<void>((ok, err) => {
      const child = spawn("revenant", ["--help"], { stdio: "ignore" });
      child.on("error", err);
      child.on("exit", (code) => (code === 0 ? ok() : err(new Error("no"))));
    });
    return "revenant";
  } catch {
    return null;
  }
}

export function isAwsRecoveryMode(claimed: ClaimedPayload): boolean {
  return (
    claimed.database.recoveryMode === "aws-rds" ||
    claimed.recovery?.engine === "aws-rds"
  );
}

export function buildDatabaseUrl(claimed: ClaimedPayload): string | null {
  const { host, port, databaseName, username, sslMode } = claimed.database;
  if (!host || !databaseName || !username || !claimed.password) {
    return null;
  }
  const user = encodeURIComponent(username);
  const pass = encodeURIComponent(claimed.password);
  const dbName = encodeURIComponent(databaseName);
  const p = port ?? 5432;
  const mode =
    !sslMode || sslMode === ""
      ? host === "localhost" || host === "127.0.0.1"
        ? "disable"
        : "require"
      : sslMode;
  const ssl = mode === "disable" ? "" : `?sslmode=${encodeURIComponent(mode)}`;
  return `postgresql://${user}:${pass}@${host}:${p}/${dbName}${ssl}`;
}

function extractChecksBlock(planYaml: string | null): string {
  const checksMatch = planYaml?.match(/checks:\s*\n[\s\S]*/i);
  let checksBlock = checksMatch?.[0]?.trimEnd() ?? "";

  if (!checksBlock) {
    checksBlock = "checks:\n  - type: connect";
  } else {
    checksBlock = checksBlock.replace(
      /(^\s*- type:\s*schema\s*\n)(\s*)tables:/gm,
      "$1$2expect_tables:"
    );
  }
  return checksBlock;
}

/** Build CLI config for direct Postgres connection. */
export function buildDirectCliConfigYaml(
  planYaml: string | null,
  planName: string
): string {
  return [
    `plan: ${JSON.stringify(planName)}`,
    "database:",
    "  engine: postgres",
    "  connection: ${DATABASE_URL}",
    "",
    extractChecksBlock(planYaml),
    "",
  ].join("\n");
}

/** Build CLI config for AWS snapshot restore drill. */
export function buildAwsCliConfigYaml(
  planYaml: string | null,
  planName: string,
  recovery: AwsRecoveryConfig
): string {
  const lines = [
    `plan: ${JSON.stringify(planName)}`,
    "database:",
    "  engine: postgres",
    "  connection: postgres://${SANDBOX_USER}:${SANDBOX_PASSWORD}@${SANDBOX_ENDPOINT}:5432/${SANDBOX_DBNAME}?sslmode=require",
    "",
    "recovery:",
    "  engine: aws-rds",
    `  source_identifier: ${JSON.stringify(recovery.sourceIdentifier)}`,
    `  region: ${JSON.stringify(recovery.region)}`,
  ];

  if (recovery.useFreetier) {
    lines.push("  use_freetier: true");
  }
  if (recovery.sandboxInstanceClass) {
    lines.push(
      `  sandbox_instance_class: ${JSON.stringify(recovery.sandboxInstanceClass)}`
    );
  }

  lines.push("", extractChecksBlock(planYaml), "");
  return lines.join("\n");
}

function runCommand(
  bin: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr?.on("data", (d) => {
      stderr += String(d);
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, opts.timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr });
    });
  });
}

function mapCliReport(report: CliReport): CheckResult[] {
  const checks = report.checks ?? [];
  if (checks.length === 0) {
    return [
      {
        checkName: "verify",
        checkType: "verify",
        status: report.status?.toUpperCase() === "PASS" ? "pass" : "fail",
        message: "CLI finished without per-check details",
        durationMs: 0,
      },
    ];
  }
  return checks.map((c) => {
    const name = c.name ?? "check";
    const st = (c.status ?? "FAIL").toUpperCase();
    return {
      checkName: name,
      checkType: name.split(":")[0] ?? "check",
      status: st === "PASS" ? ("pass" as const) : ("fail" as const),
      message: c.message ?? st,
      durationMs: 0,
    };
  });
}

function buildCliEnv(
  claimed: ClaimedPayload,
  awsMode: boolean
): { env: NodeJS.ProcessEnv; error?: string } {
  if (awsMode) {
    const { username, databaseName } = claimed.database;
    const recovery = claimed.recovery;
    const aws = claimed.awsCredentials;

    if (!recovery?.sourceIdentifier || !recovery.region) {
      return {
        env: process.env,
        error: "AWS recovery config incomplete — set RDS instance ID and region",
      };
    }
    if (!aws?.accessKeyId || !aws.secretAccessKey) {
      return {
        env: process.env,
        error: "AWS credentials missing — add access keys on the database",
      };
    }
    if (!username || !claimed.password || !databaseName) {
      return {
        env: process.env,
        error:
          "RDS master username, password, and database name required for sandbox connection",
      };
    }

    return {
      env: {
        ...process.env,
        AWS_ACCESS_KEY_ID: aws.accessKeyId,
        AWS_SECRET_ACCESS_KEY: aws.secretAccessKey,
        AWS_REGION: recovery.region,
        SANDBOX_USER: username,
        SANDBOX_PASSWORD: claimed.password,
        SANDBOX_DBNAME: databaseName,
        ...(buildDatabaseUrl(claimed)
          ? { DATABASE_URL: buildDatabaseUrl(claimed)! }
          : {}),
      },
    };
  }

  const databaseUrl = buildDatabaseUrl(claimed);
  if (!databaseUrl) {
    return {
      env: process.env,
      error: "Missing host, database name, username, or password",
    };
  }

  return {
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
    },
  };
}

async function runWithCli(
  claimed: ClaimedPayload,
  cliPath: string,
  executionMode: "stub" | "agent" | "ci"
): Promise<ExecutionOutcome> {
  const started = Date.now();
  const awsMode = isAwsRecoveryMode(claimed);
  const { env, error } = buildCliEnv(claimed, awsMode);

  if (error) {
    return {
      status: "fail",
      executionMode,
      usedCli: false,
      rtoSeconds: 1,
      errorMessage: error,
      results: [
        {
          checkName: "connect",
          checkType: "connect",
          status: "fail",
          message: error,
          durationMs: 0,
        },
      ],
    };
  }

  const planName = claimed.job.databaseName || "cloud-job";
  const yaml = awsMode && claimed.recovery
    ? buildAwsCliConfigYaml(claimed.planYaml, planName, claimed.recovery)
    : buildDirectCliConfigYaml(claimed.planYaml, planName);

  const dir = await mkdtemp(join(tmpdir(), "revenant-job-"));
  try {
    const configPath = join(dir, "revenant.yaml");
    const reportPath = join(dir, "report.json");
    await writeFile(configPath, yaml, "utf8");

    const timeoutMs = awsMode ? AWS_VERIFY_TIMEOUT_MS : DIRECT_VERIFY_TIMEOUT_MS;
    const results: CheckResult[] = [];
    const fullDrill = Boolean(claimed.fullDrill && awsMode);

    if (fullDrill) {
      const snapStarted = Date.now();
      const snap = await runCommand(cliPath, ["snapshot", "-c", configPath], {
        cwd: dir,
        env,
        timeoutMs: AWS_VERIFY_TIMEOUT_MS,
      });
      const snapOk = snap.code === 0;
      results.push({
        checkName: "snapshot",
        checkType: "snapshot",
        status: snapOk ? "pass" : "fail",
        message: snapOk
          ? (snap.stdout || "RDS snapshot created").slice(0, 400)
          : (snap.stderr || snap.stdout || "revenant snapshot failed").slice(0, 500),
        durationMs: Date.now() - snapStarted,
      });
      if (!snapOk) {
        return {
          status: "fail",
          executionMode,
          usedCli: true,
          rtoSeconds: Math.max(1, Math.round((Date.now() - started) / 1000)),
          errorMessage: results[0]?.message,
          results,
        };
      }
    }

    const { code, stdout, stderr } = await runCommand(
      cliPath,
      ["verify", "-c", configPath, "-o", reportPath, "--markdown", join(dir, "report.md")],
      {
        cwd: dir,
        env,
        timeoutMs,
      }
    );

    let report: CliReport = {};
    try {
      report = JSON.parse(await readFile(reportPath, "utf8")) as CliReport;
    } catch {
      report = {};
    }

    const verifyResults = mapCliReport(report);
    if (verifyResults.length === 0 && (stdout || stderr)) {
      verifyResults.push({
        checkName: "verify",
        checkType: "verify",
        status: code === 0 ? "pass" : "fail",
        message: (stderr || stdout).slice(0, 500),
        durationMs: Date.now() - started,
      });
    }
    results.push(...verifyResults);

    const verifyFailed =
      code !== 0 ||
      report.status?.toUpperCase() === "FAIL" ||
      verifyResults.some((r) => r.status === "fail");

    if (fullDrill) {
      const reapStarted = Date.now();
      const reap = await runCommand(
        cliPath,
        ["reap", "--max-age", "2h", "--region", claimed.recovery?.region ?? ""],
        { cwd: dir, env, timeoutMs: 180_000 }
      );
      results.push({
        checkName: "reap",
        checkType: "reap",
        status: reap.code === 0 ? "pass" : "skip",
        message:
          reap.code === 0
            ? (reap.stdout || "Orphan sandboxes cleaned").slice(0, 400)
            : (reap.stderr || reap.stdout || "reap skipped").slice(0, 400),
        durationMs: Date.now() - reapStarted,
      });
    }

    const failed = verifyFailed || results.some((r) => r.status === "fail");

    return {
      status: failed ? "fail" : "pass",
      executionMode,
      usedCli: true,
      rtoSeconds: Math.max(1, Math.round((Date.now() - started) / 1000)),
      errorMessage: failed
        ? (stderr || stdout || "revenant verify failed").slice(0, 500)
        : undefined,
      results,
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function runMetadataFallback(
  claimed: ClaimedPayload,
  executionMode: "stub" | "agent" | "ci",
  reason: string
): ExecutionOutcome {
  const started = Date.now();
  const awsMode = isAwsRecoveryMode(claimed);
  const hasTarget = awsMode
    ? Boolean(
        claimed.recovery?.sourceIdentifier &&
          claimed.awsCredentials &&
          claimed.password &&
          claimed.database.username
      )
    : Boolean(claimed.database.host && claimed.password);
  const hasPlan = Boolean(claimed.planYaml);
  const simulated = executionMode === "stub";

  const results: CheckResult[] = [
    {
      checkName: awsMode ? "aws-recovery" : "connect",
      checkType: awsMode ? "aws-rds" : "connect",
      status: hasTarget ? "pass" : "fail",
      message: `${simulated ? "[SIMULATED] " : ""}${
        hasTarget
          ? awsMode
            ? `AWS restore drill configured for ${claimed.recovery?.sourceIdentifier} (${reason})`
            : `Target ${claimed.database.host}:${claimed.database.port ?? 5432} received (${reason})`
          : awsMode
            ? "Missing AWS recovery config or credentials"
            : "Missing host or password"
      }`,
      durationMs: 40,
    },
    {
      checkName: "plan",
      checkType: "plan",
      status: hasPlan ? "pass" : "fail",
      message: `${simulated ? "[SIMULATED] " : ""}${
        hasPlan ? "Validation plan present" : "No validation plan"
      }`,
      durationMs: 10,
    },
  ];

  const failed = results.some((r) => r.status === "fail");
  return {
    status: failed ? "fail" : "pass",
    executionMode,
    usedCli: false,
    rtoSeconds: Math.max(1, Math.round((Date.now() - started) / 1000)),
    errorMessage: failed
      ? simulated
        ? "Stub checks failed (SIMULATED — not a real DB check)"
        : "Agent checks failed (CLI not available)"
      : undefined,
    results,
  };
}

/**
 * Execute a claimed job: prefer real `revenant verify`, else metadata fallback.
 * Stub mode still tries CLI when available so local `npm run dev` can be real.
 */
export async function executeClaimedJob(
  claimed: ClaimedPayload,
  executionMode: "stub" | "agent" | "ci"
): Promise<ExecutionOutcome> {
  const forceSim =
    process.env.REVENANT_FORCE_SIMULATE === "true" ||
    (executionMode === "stub" && process.env.REVENANT_STUB_SIMULATE === "true");

  if (forceSim) {
    return runMetadataFallback(claimed, executionMode, "forced simulation");
  }

  const cli = await resolveRevenantCli();
  if (!cli) {
    return runMetadataFallback(
      claimed,
      executionMode,
      "revenant CLI not found — set REVENANT_CLI_PATH"
    );
  }

  return runWithCli(claimed, cli, executionMode);
}
