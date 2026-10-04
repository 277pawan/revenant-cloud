import { spawn } from "node:child_process";
import {
  access,
  constants,
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AwsRecoveryConfig, RecoveryMode, RunnerAwsCredentials } from "@revenant/shared";
import {
  collectHttpHealthSpecs,
  runHttpHealthChecks,
  stripHttpHealthFromChecksBlock,
} from "./http-health-checks.js";

type AwsRecoveryJobConfig = Omit<AwsRecoveryConfig, "maxLifetimeMinutes"> & {
  maxLifetimeMinutes: number | null;
  cleanupCustomerSnapshots: boolean;
  snapshotIdentifier?: string;
};

export type ClaimedPayload = {
  job: { id: string; databaseName: string };
  database: {
    id: string;
    engine: "postgres" | "mysql";
    host: string | null;
    port: number | null;
    databaseName: string | null;
    username: string | null;
    sslMode?: string | null;
    recoveryMode?: RecoveryMode;
  };
  password: string | null;
  recovery: AwsRecoveryJobConfig | null;
  awsCredentials: RunnerAwsCredentials | null;
  planYaml: string | null;
  /** Recovery contract application checks (healthcheck URL + optional endpoints) */
  contractApplication?: {
    healthcheck?: string;
    endpoints?: Array<{
      name: string;
      method: string;
      path: string;
      expect_status?: number;
    }>;
  } | null;
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

export type RunnerProgressStage =
  | "runner_starting"
  | "resolving_cli"
  | "checking_source"
  | "creating_snapshot"
  | "waiting_for_snapshot"
  | "selecting_snapshot"
  | "restoring_sandbox"
  | "waiting_for_sandbox"
  | "connecting_sandbox"
  | "running_checks"
  | "cleaning_sandbox"
  | "reaping_sandboxes";

export type ReportRunnerProgress = (
  stage: RunnerProgressStage,
  message: string,
  checks?: Array<{
    checkName: string;
    checkType: string;
    status: "pass" | "fail" | "skip";
    message: string | null;
  }>
) => Promise<void>;

type CliReport = {
  status?: string;
  checks?: Array<{ name?: string; status?: string; message?: string }>;
  recovery?: {
    snapshot_identifier?: string;
    snapshot_arn?: string;
    temporary_instance_identifier?: string;
    run_id?: string;
    expires_at?: string;
    instance_class?: string;
    estimated_storage_gb?: number;
    rto_seconds?: number;
    cleanup_status?: string;
    cleanup_error?: string;
  };
};

export function mapCliCleanupResult(
  cleanup: NonNullable<CliReport["recovery"]>
): CheckResult {
  const cleanupStatus = cleanup.cleanup_status?.toUpperCase() ?? "NOT_CREATED";
  const status = cleanupStatus === "CLEANED"
    ? "pass"
    : cleanupStatus === "CLEANUP_FAILED"
      ? "fail"
      : "skip";
  const instance = cleanup.temporary_instance_identifier
    ? ` ${cleanup.temporary_instance_identifier}`
    : "";
  const detail = cleanup.cleanup_error ? `: ${cleanup.cleanup_error}` : "";
  return {
    checkName: "temp_instance_cleanup",
    checkType: "cleanup",
    status,
    message: `Temporary RDS${instance} cleanup ${cleanupStatus.toLowerCase()}${detail}`.slice(0, 500),
    durationMs: 0,
  };
}

const AWS_VERIFY_TIMEOUT_MS = Number(
  process.env.REVENANT_AWS_VERIFY_TIMEOUT_MS ?? 2_100_000
);
const DIRECT_VERIFY_TIMEOUT_MS = Number(
  process.env.REVENANT_VERIFY_TIMEOUT_MS ?? 120_000
);
const GITHUB_REQUEST_TIMEOUT_MS = 30_000;

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function resolveConfiguredCliPath(
  configuredPath = process.env.REVENANT_CLI_PATH
): Promise<string | null> {
  const path = configuredPath?.trim();
  if (!path || !(await fileExists(path))) return null;
  return path;
}

export function buildReleaseAssetName(version: string): string | null {
  const normalizedVersion = version.replace(/^v/, "");
  const platform = process.platform;
  const arch = process.arch;

  const osName =
    platform === "linux"
      ? "linux"
      : platform === "darwin"
        ? "darwin"
        : platform === "win32"
          ? "windows"
          : null;

  if (!osName) return null;

  const archName =
    arch === "x64"
      ? "amd64"
      : arch === "arm64"
        ? "arm64"
        : arch === "arm"
          ? "arm64"
          : null;

  if (!archName) return null;

  const suffix = osName === "windows" ? "zip" : "tar.gz";
  return `revenant_${normalizedVersion}_${osName}_${archName}.${suffix}`;
}

export function buildGitHubReleaseHeaders(
  accept: string,
  token = process.env.REVENANT_CLI_GITHUB_TOKEN
): Record<string, string> {
  const normalizedToken = token?.trim();
  return {
    Accept: accept,
    ...(normalizedToken ? { Authorization: `Bearer ${normalizedToken}` } : {}),
  };
}

function cliProcessEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.REVENANT_CLI_GITHUB_TOKEN;
  return env;
}

async function installLatestRevenantCli(): Promise<string | null> {
  const repo = process.env.REVENANT_CLI_REPO ?? "277pawan/revenant-cli";
  const targetDir = process.env.REVENANT_CLI_DIR ?? resolve(process.cwd(), ".revenant-bin");
  const releaseVersion = process.env.REVENANT_CLI_VERSION ?? "latest";
  const releaseEndpoint = releaseVersion === "latest"
    ? `https://api.github.com/repos/${repo}/releases/latest`
    : `https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(releaseVersion)}`;
  const token = process.env.REVENANT_CLI_GITHUB_TOKEN;

  console.log(
    `[revenant-resolver] requesting GitHub release repo=${repo} version=${releaseVersion} ` +
      `authentication=${token?.trim() ? "configured" : "not configured"}`
  );
  const lookupStartedAt = Date.now();
  let releaseResponse: Response;
  try {
    releaseResponse = await fetch(releaseEndpoint, {
      headers: buildGitHubReleaseHeaders("application/vnd.github+json", token),
      signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    console.warn(
      `[revenant-resolver] GitHub release lookup request failed after ${Date.now() - lookupStartedAt}ms:`,
      error instanceof Error ? error.message : error
    );
    return null;
  }
  if (!releaseResponse.ok) {
    console.warn(
      `[revenant-resolver] GitHub release lookup failed: HTTP ${releaseResponse.status} ` +
        `(${Date.now() - lookupStartedAt}ms)`
    );
    return null;
  }
  console.log(
    `[revenant-resolver] GitHub release lookup succeeded (${Date.now() - lookupStartedAt}ms)`
  );

  const release = (await releaseResponse.json()) as {
    tag_name?: string;
    assets?: Array<{ id: number; name: string }>;
  };
  const version = release.tag_name;
  if (!version) {
    console.warn("[revenant-resolver] GitHub release response did not contain a tag");
    return null;
  }

  const assetName = buildReleaseAssetName(version);
  if (!assetName) return null;

  const asset = release.assets?.find((candidate) => candidate.name === assetName);
  if (!asset) {
    console.warn(`[revenant-resolver] release ${version} is missing expected asset ${assetName}`);
    return null;
  }

  console.log(`[revenant-resolver] downloading CLI asset=${assetName}`);
  await mkdir(targetDir, { recursive: true });
  const installDir = targetDir;
  const archivePath = join(installDir, assetName);
  const archiveUrl = `https://api.github.com/repos/${repo}/releases/assets/${asset.id}`;
  const archiveResponse = await fetch(archiveUrl, {
    headers: buildGitHubReleaseHeaders("application/octet-stream", token),
    signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
  });
  if (!archiveResponse.ok) {
    console.warn(`[revenant-resolver] GitHub release asset download failed: HTTP ${archiveResponse.status}`);
    return null;
  }

  const archiveBuffer = Buffer.from(await archiveResponse.arrayBuffer());
  await writeFile(archivePath, archiveBuffer);
  console.log(`[revenant-resolver] downloaded ${archiveBuffer.byteLength} bytes; extracting CLI`);

  const unpackDir = join(targetDir, `extract-${Date.now()}`);
  await mkdir(unpackDir, { recursive: true });

  const command = process.platform === "win32" ? "powershell" : "tar";
  const args = process.platform === "win32"
    ? [
        "-NoLogo",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `Expand-Archive -LiteralPath '${archivePath}' -DestinationPath '${unpackDir}' -Force`,
      ]
    : ["-xzf", archivePath, "-C", unpackDir];

  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolvePromise() : reject(new Error(`extract failed with code ${code}`))));
  });

  const candidates: string[] = [
    join(unpackDir, "revenant"),
    join(targetDir, "revenant"),
  ];

  const found = await (async () => {
    for (const candidate of candidates) {
      if (await fileExists(candidate)) return candidate;
    }

    try {
      const entries = await readdir(unpackDir, { recursive: true });
      const nested = entries.filter((entry) => typeof entry === "string" && entry.endsWith("/revenant"));
      for (const entry of nested) {
        const full = join(unpackDir, entry);
        if (await fileExists(full)) return full;
      }
    } catch {
      // Ignore unmatched extraction layout
    }

    return null;
  })();

  if (!found) {
    await rm(unpackDir, { recursive: true, force: true }).catch(() => undefined);
    return null;
  }

  const finalBin = join(targetDir, "revenant");
  await copyFile(found, finalBin);
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn("chmod", ["+x", finalBin], { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolvePromise() : reject(new Error(`chmod failed with code ${code}`))));
  });

  process.env.REVENANT_CLI_PATH = finalBin;
  await rm(unpackDir, { recursive: true, force: true }).catch(() => undefined);
  return finalBin;
}

/** Resolve the CLI once per API process; jobs reuse the same downloaded release binary. */
let cliResolution: Promise<string | null> | null = null;

async function resolveRevenantCliOnce(): Promise<string | null> {
  const configuredPath = process.env.REVENANT_CLI_PATH?.trim();
  if (configuredPath) {
    console.log("[revenant-resolver] checking explicitly configured REVENANT_CLI_PATH");
    const configuredBinary = await resolveConfiguredCliPath(configuredPath);
    if (!configuredBinary) {
      console.error("[revenant-resolver] configured REVENANT_CLI_PATH does not exist or is not accessible; no alternate binary will be used");
      return null;
    }
    console.log("[revenant-resolver] configured CLI binary is accessible");
    return configuredBinary;
  }

  try {
    const installed = await installLatestRevenantCli();
    if (installed) {
      console.log(`[revenant-resolver] using GitHub release binary=${installed}`);
      return installed;
    }
  } catch (error) {
    console.warn(
      "[revenant-resolver] CLI installation from GitHub failed:",
      error instanceof Error ? error.message : error
    );
  }

  console.error("[revenant-resolver] no CLI binary available; refusing to run without real checks");
  return null;
}

export function resolveRevenantCli(): Promise<string | null> {
  cliResolution ??= resolveRevenantCliOnce();
  return cliResolution;
}

export function isAwsRecoveryMode(claimed: ClaimedPayload): boolean {
  return (
    claimed.database.recoveryMode === "aws-rds" ||
    claimed.recovery?.engine === "aws-rds"
  );
}

export function buildDatabaseUrl(claimed: ClaimedPayload): string | null {
  const { engine, host, port, databaseName, username, sslMode } = claimed.database;
  if (!host || !databaseName || !username || !claimed.password) {
    return null;
  }
  const user = encodeURIComponent(username);
  const pass = encodeURIComponent(claimed.password);
  const dbName = encodeURIComponent(databaseName);
  const p = port ?? (engine === "mysql" ? 3306 : 5432);
  if (engine === "mysql") {
    const tls = mysqlTlsQuery(sslMode);
    return `mysql://${user}:${pass}@${host}:${p}/${dbName}${tls}`;
  }
  const mode =
    !sslMode || sslMode === ""
      ? host === "localhost" || host === "127.0.0.1"
        ? "disable"
        : "require"
      : sslMode;
  const ssl = mode === "disable" ? "" : `?sslmode=${encodeURIComponent(mode)}`;
  return `postgresql://${user}:${pass}@${host}:${p}/${dbName}${ssl}`;
}

function mysqlTlsQuery(sslMode?: string | null): string {
  if (sslMode === "disable") return "";
  return `?tls=${sslMode === "prefer" ? "preferred" : "skip-verify"}`;
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

  // http_health runs in Node (see runHttpHealthChecks) — older revenant CLI builds reject it.
  return stripHttpHealthFromChecksBlock(checksBlock);
}

/** Build CLI config for a direct SQL connection. */
export function buildDirectCliConfigYaml(
  planYaml: string | null,
  planName: string,
  engine: "postgres" | "mysql"
): string {
  return [
    `plan: ${JSON.stringify(planName)}`,
    "database:",
    `  engine: ${engine}`,
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
  recovery: AwsRecoveryJobConfig,
  databaseId: string,
  jobId: string,
  engine: "postgres" | "mysql" = "postgres",
  sslMode?: string | null
): string {
  const sandboxPort = engine === "mysql" ? 3306 : 5432;
  const sandboxConnection = engine === "mysql"
    ? `mysql://\${SANDBOX_USER}:\${SANDBOX_PASSWORD}@\${SANDBOX_ENDPOINT}:${sandboxPort}/\${SANDBOX_DBNAME}${mysqlTlsQuery(sslMode)}`
    : `postgres://\${SANDBOX_USER}:\${SANDBOX_PASSWORD}@\${SANDBOX_ENDPOINT}:${sandboxPort}/\${SANDBOX_DBNAME}?sslmode=require`;
  const lines = [
    `plan: ${JSON.stringify(planName)}`,
    "database:",
    `  engine: ${engine}`,
    `  connection: ${sandboxConnection}`,
    "",
    "recovery:",
    "  engine: aws-rds",
    `  source_identifier: ${JSON.stringify(recovery.sourceIdentifier)}`,
    "  source_connection: ${SOURCE_DATABASE_URL}",
    `  region: ${JSON.stringify(recovery.region)}`,
    `  database_id: ${JSON.stringify(databaseId)}`,
    `  run_id: ${JSON.stringify(jobId)}`,
  ];
  if (recovery.snapshotIdentifier) {
    lines.push(`  snapshot_identifier: ${JSON.stringify(recovery.snapshotIdentifier)}`);
  }
  if (recovery.maxLifetimeMinutes === null) {
    lines.push("  retain_resources: true");
  } else {
    lines.push(`  max_lifetime_minutes: ${recovery.maxLifetimeMinutes}`);
  }
  if (recovery.cleanupCustomerSnapshots) {
    lines.push("  cleanup_customer_snapshots: true");
  }

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

function sanitizeCliOutput(value: string, env: NodeJS.ProcessEnv): string {
  let sanitized = value;
  for (const [key, secret] of Object.entries(env)) {
    if (
      secret &&
      secret.length >= 4 &&
      (key === "DATABASE_URL" || /(PASSWORD|SECRET|TOKEN|ACCESS_KEY)/i.test(key))
    ) {
      sanitized = sanitized
        .split(secret)
        .join(key === "DATABASE_URL" ? "[REDACTED_DATABASE_URL]" : "[REDACTED]");
    }
  }
  return sanitized
    .replace(/(https?:\/\/[^:/\s@]+:)[^@\s/]+@/gi, "$1[REDACTED]@")
    .replace(/((?:password|passwd|secret|token|authorization)\s*[=:]\s*)\S+/gi, "$1[REDACTED]")
    .slice(0, 2000);
}

function runCommand(
  bin: string,
  args: string[],
  opts: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    label: string;
    onProgress?: ReportRunnerProgress;
    heartbeat?: { stage: RunnerProgressStage; message: string };
  }
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const startedAt = Date.now();
    console.log(
      `[runner-cli] starting ${opts.label} timeout=${opts.timeoutMs}ms`
    );
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let stdoutLine = "";
    let stderrLine = "";
    let progressQueue = Promise.resolve();
    const progressChecks: Array<{
      checkName: string;
      checkType: string;
      status: "pass" | "fail";
      message: string;
    }> = [];
    let lastProgressStage: RunnerProgressStage = opts.label.includes("step=snapshot")
      ? "checking_source"
      : "running_checks";
    const heartbeat = opts.heartbeat;
    const heartbeatTimer = opts.onProgress && heartbeat
      ? setInterval(() => {
          progressQueue = progressQueue
            .then(() => opts.onProgress?.(heartbeat.stage, heartbeat.message))
            .then(() => undefined)
            .catch((error: unknown) => {
              console.error(
                `[runner-cli] ${opts.label} heartbeat reporting failed:`,
                error instanceof Error ? error.message : error
              );
            });
        }, 2 * 60_000)
      : undefined;
    const reportLineProgress = (line: string) => {
      const progress = mapCliOutputProgress(opts.label, line);
      if (progress) lastProgressStage = progress.stage;
      const outputCheck = mapCliCheckOutput(opts.label, line);
      if ((!progress && !outputCheck) || !opts.onProgress) return;
      if (outputCheck) progressChecks.push(outputCheck);
      const stage = progress?.stage ?? lastProgressStage;
      const message = (
        progress?.message ?? `Completed check: ${outputCheck?.checkName}`
      ).slice(0, 255);
      progressQueue = progressQueue
        .then(() =>
          opts.onProgress?.(stage, message, progressChecks.slice(-100))
        )
        .then(() => undefined)
        .catch((error: unknown) => {
          console.error(
            `[runner-cli] ${opts.label} progress reporting failed:`,
            error instanceof Error ? error.message : error
          );
        });
    };
    const logOutput = (
      chunk: Buffer,
      stream: "stdout" | "stderr",
      pending: string
    ): string => {
      const lines = (pending + chunk.toString()).split(/\r\n|\n|\r/);
      const remaining = lines.pop() ?? "";
      for (const line of lines) {
        if (!line) continue;
        reportLineProgress(line);
        const message = `[runner-cli] ${opts.label} ${stream}: ${sanitizeCliOutput(line, opts.env)}`;
        if (stream === "stderr") console.error(message);
        else console.log(message);
      }
      if (remaining.length > 4000) {
        const partial = `[runner-cli] ${opts.label} ${stream}: ${sanitizeCliOutput(remaining, opts.env)}`;
        if (stream === "stderr") console.error(partial);
        else console.log(partial);
        return "";
      }
      return remaining;
    };
    child.stdout?.on("data", (d) => {
      const chunk = Buffer.from(d);
      stdout += chunk.toString();
      stdoutLine = logOutput(chunk, "stdout", stdoutLine);
    });
    child.stderr?.on("data", (d) => {
      const chunk = Buffer.from(d);
      stderr += chunk.toString();
      stderrLine = logOutput(chunk, "stderr", stderrLine);
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      console.error(`[runner-cli] ${opts.label} exceeded timeout; stopping process`);
      child.kill("SIGKILL");
    }, opts.timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      console.error(
        `[runner-cli] ${opts.label} failed to start after ${Date.now() - startedAt}ms:`,
        error.message
      );
      rejectPromise(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (stdoutLine) {
        console.log(
          `[runner-cli] ${opts.label} stdout: ${sanitizeCliOutput(stdoutLine, opts.env)}`
        );
      }
      if (stderrLine) {
        console.error(
          `[runner-cli] ${opts.label} stderr: ${sanitizeCliOutput(stderrLine, opts.env)}`
        );
      }
      console.log(
        `[runner-cli] finished ${opts.label} exitCode=${code ?? "unknown"} ` +
          `timedOut=${timedOut} duration=${Date.now() - startedAt}ms`
      );
      void progressQueue.then(() => resolvePromise({ code, stdout, stderr }));
    });

  });
}

export function mapCliCheckOutput(
  label: string,
  line: string
): {
  checkName: string;
  checkType: string;
  status: "pass" | "fail";
  message: string;
} | null {
  const match = line.trim().match(/^([✓✗])\s+(.+)$/);
  if (!match) return null;
  const [, marker, rawMessage] = match;
  const message = rawMessage.slice(0, 255);
  if (!label.includes("step=snapshot")) return null;
  return {
    checkName: message,
    checkType: "source_validation",
    status: marker === "✓" ? "pass" : "fail",
    message,
  };
}

export function mapCliOutputProgress(
  label: string,
  line: string
): { stage: RunnerProgressStage; message: string } | null {
  const normalized = line.toLowerCase();
  if (label.includes("step=snapshot")) {
    if (
      normalized.includes("waiting") && normalized.includes("snapshot") ||
      normalized.includes("snapshot status")
    ) {
      return {
        stage: "waiting_for_snapshot",
        message: "Waiting for AWS to finish creating the snapshot.",
      };
    }
    if (normalized.includes("creating") && normalized.includes("snapshot")) {
      return {
        stage: "creating_snapshot",
        message: "Creating a new AWS snapshot of the source database.",
      };
    }
  }
  if (label.includes("step=verify")) {
    if (normalized.includes("finding") && normalized.includes("snapshot")) {
      return {
        stage: "selecting_snapshot",
        message: "Finding the latest eligible AWS snapshot.",
      };
    }
    if (normalized.includes("restoring") && normalized.includes("sandbox")) {
      return {
        stage: "restoring_sandbox",
        message: "AWS is provisioning a temporary database from the snapshot.",
      };
    }
    if (
      normalized.includes("waiting") && normalized.includes("sandbox") ||
      normalized.includes("instance status")
    ) {
      return {
        stage: "waiting_for_sandbox",
        message: "Waiting for the temporary AWS database to become available.",
      };
    }
    if (normalized.includes("connecting") && normalized.includes("sandbox")) {
      return {
        stage: "connecting_sandbox",
        message: "Connecting to the restored database before validation.",
      };
    }
    if (
      normalized.includes("running") && normalized.includes("check") ||
      normalized.includes("validation check") ||
      normalized.includes("connected to postgres")
    ) {
      return {
        stage: "running_checks",
        message: "Running the configured validation checks on the restored database.",
      };
    }
    if (
      normalized.includes("cleaning up") ||
      normalized.includes("destroying temporary")
    ) {
      return {
        stage: "cleaning_sandbox",
        message: "Requesting deletion of the temporary validation database.",
      };
    }
  }
  return null;
}

export function mapCliReport(
  report: CliReport,
  checkType?: string,
  fallbackMessage?: string
): CheckResult[] {
  const checks = report.checks ?? [];
  if (checks.length === 0) {
    return [
      {
        checkName: "verify",
        checkType: "verify",
        status: report.status?.toUpperCase() === "PASS" ? "pass" : "fail",
        message: fallbackMessage?.slice(0, 500) || "CLI finished without per-check details",
        durationMs: 0,
      },
    ];
  }
  return checks.map((c) => {
    const name = c.name ?? "check";
    const st = (c.status ?? "FAIL").toUpperCase();
    return {
      checkName: name,
      checkType: checkType ?? name.split(":")[0] ?? "check",
      status: st === "PASS" ? ("pass" as const) : ("fail" as const),
      message: c.message ?? st,
      durationMs: 0,
    };
  });
}

export function buildCliEnv(
  claimed: ClaimedPayload,
  awsMode: boolean
): { env: NodeJS.ProcessEnv; error?: string } {
  const baseEnv = cliProcessEnvironment();
  if (awsMode) {
    const { host, username, databaseName } = claimed.database;
    const recovery = claimed.recovery;
    const aws = claimed.awsCredentials;

    if (!recovery?.sourceIdentifier || !recovery.region) {
      return {
        env: baseEnv,
        error: "AWS recovery config incomplete — set RDS instance ID and region",
      };
    }
    if (!aws?.accessKeyId || !aws.secretAccessKey) {
      return {
        env: baseEnv,
        error: "AWS credentials missing — add access keys on the database",
      };
    }
    if (!host || !username || !claimed.password || !databaseName) {
      return {
        env: baseEnv,
        error:
          "Source RDS host, master username, password, and database name are required",
      };
    }
    const databaseUrl = buildDatabaseUrl(claimed);
    if (!databaseUrl) {
      return {
        env: baseEnv,
        error: "Could not build a source database URL for the selected database engine",
      };
    }

    return {
      env: {
        ...baseEnv,
        AWS_ACCESS_KEY_ID: aws.accessKeyId,
        AWS_SECRET_ACCESS_KEY: aws.secretAccessKey,
        ...(aws.sessionToken ? { AWS_SESSION_TOKEN: aws.sessionToken } : {}),
        AWS_REGION: recovery.region,
        SANDBOX_USER: username,
        SANDBOX_PASSWORD: claimed.password,
        SANDBOX_DBNAME: databaseName,
        DATABASE_URL: databaseUrl,
        SOURCE_DATABASE_URL: databaseUrl,
      },
    };
  }

  const databaseUrl = buildDatabaseUrl(claimed);
  if (!databaseUrl) {
    return {
      env: baseEnv,
      error: "Missing host, database name, username, or password",
    };
  }

  return {
    env: {
      ...baseEnv,
      DATABASE_URL: databaseUrl,
    },
  };
}

async function runWithCli(
  claimed: ClaimedPayload,
  cliPath: string,
  executionMode: "stub" | "agent" | "ci",
  reportProgress: ReportRunnerProgress
): Promise<ExecutionOutcome> {
  const started = Date.now();
  const awsMode = isAwsRecoveryMode(claimed);
  console.log(
    `[runner] job=${claimed.job.id} preparing CLI execution mode=${executionMode} ` +
      `databaseEngine=${claimed.database.engine} recovery=${awsMode ? "aws-rds" : "direct"}`
  );
  const { env, error } = buildCliEnv(claimed, awsMode);

  if (error) {
    console.error(`[runner] job=${claimed.job.id} CLI configuration failed: ${error}`);
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
  const httpSpecs = collectHttpHealthSpecs(claimed.planYaml, claimed.contractApplication);
  const yaml = awsMode && claimed.recovery
    ? buildAwsCliConfigYaml(
        claimed.planYaml,
        planName,
        claimed.recovery,
        claimed.database.id,
        claimed.job.id,
        claimed.database.engine,
        claimed.database.sslMode
      )
    : buildDirectCliConfigYaml(claimed.planYaml, planName, claimed.database.engine);

  const dir = await mkdtemp(join(tmpdir(), "revenant-job-"));
  try {
    const configPath = join(dir, "revenant.yaml");
    const reportPath = join(dir, "report.json");
    await writeFile(configPath, yaml, "utf8");

    const timeoutMs = awsMode ? AWS_VERIFY_TIMEOUT_MS : DIRECT_VERIFY_TIMEOUT_MS;
    const results: CheckResult[] = [];
    const fullDrill = Boolean(claimed.fullDrill && awsMode);
    if (awsMode && claimed.recovery) {
      console.log(
        `[runner] job=${claimed.job.id} AWS resource estimate ` +
          `temporaryRdsInstances=1 ` +
          `newSnapshot=${fullDrill} ` +
          `instanceClass=${claimed.recovery.sandboxInstanceClass ?? (claimed.recovery.useFreetier ? "db.t3.micro" : "db.t4g.micro")} ` +
          `retention=${claimed.recovery.maxLifetimeMinutes === null ? "indefinite" : `${claimed.recovery.maxLifetimeMinutes}m`} ` +
          `publiclyAccessible=true pricingEstimate=unavailable`
      );
    }
    console.log(
      `[runner] job=${claimed.job.id} CLI config written; ` +
        `verification=${awsMode ? "AWS recovery" : "direct database"} ` +
        `timeout=${timeoutMs}ms fullDrill=${fullDrill}`
    );

    if (fullDrill) {
      await reportProgress(
        "checking_source",
        "Checking the live source database against the validation plan."
      );
      const snapStarted = Date.now();
      const snap = await runCommand(cliPath, ["snapshot", "-c", configPath], {
        cwd: dir,
        env,
        timeoutMs: AWS_VERIFY_TIMEOUT_MS,
        label: `job=${claimed.job.id} step=snapshot`,
        onProgress: reportProgress,
        heartbeat: {
          stage: "waiting_for_snapshot",
          message: "The full-drill snapshot creation and source validation are still running.",
        },
      });
      const snapOk = snap.code === 0;
      let snapshotReport: CliReport = {};
      if (await fileExists(reportPath)) {
        try {
          snapshotReport = JSON.parse(await readFile(reportPath, "utf8")) as CliReport;
        } catch (error) {
          console.error(
            `[runner] job=${claimed.job.id} snapshot report could not be parsed:`,
            error instanceof Error ? error.message : error
          );
        }
      }
      const sourceChecks = snapshotReport.checks?.length
        ? mapCliReport(snapshotReport, "source_validation")
        : [];
      results.push(...sourceChecks);
      const generatedSnapshot = snapshotReport.recovery;
      if (generatedSnapshot?.snapshot_identifier) {
        const retention =
          generatedSnapshot.cleanup_status === "RETAINED"
            ? "retained indefinitely by policy"
            : generatedSnapshot.expires_at
              ? `scheduled for deletion after ${generatedSnapshot.expires_at}`
              : "automatic deletion status unavailable";
        results.push({
          checkName: "drill_snapshot_cleanup",
          checkType: "cleanup",
          status:
            generatedSnapshot.cleanup_status === "RETAINED" ||
            generatedSnapshot.expires_at
              ? "skip"
              : "fail",
          message: `Full-drill snapshot ${generatedSnapshot.snapshot_identifier} ${retention}.`,
          durationMs: 0,
        });
      }
      const snapshotResult: CheckResult = {
        checkName: "snapshot",
        checkType: "snapshot",
        status: snapOk ? "pass" : "fail",
        message: snapOk
          ? (snap.stdout || "RDS snapshot created").slice(0, 400)
          : (snap.stderr || snap.stdout || "revenant snapshot failed").slice(0, 500),
        durationMs: Date.now() - snapStarted,
      };
      results.push(snapshotResult);
      await reportProgress(
        snapOk ? "selecting_snapshot" : "checking_source",
        snapOk
          ? "Live source checks are complete; the recovery snapshot is ready. Preparing restore verification."
          : "Live source validation or recovery snapshot creation failed.",
        results.slice(-100).map((result) => ({
          checkName: result.checkName,
          checkType: result.checkType,
          status: result.status === "error" ? "fail" : result.status,
          message: result.message,
        }))
      );
      if (!snapOk) {
        console.error(
          `[runner] job=${claimed.job.id} snapshot failed after ${Date.now() - snapStarted}ms`
        );
        return {
          status: "fail",
          executionMode,
          usedCli: true,
          rtoSeconds: Math.max(1, Math.round((Date.now() - started) / 1000)),
          errorMessage: snapshotResult.message,
          results,
        };
      }
    } else if (awsMode) {
      await reportProgress(
        "selecting_snapshot",
        "Finding the latest eligible AWS snapshot; this run will not create a new snapshot."
      );
    } else {
      await reportProgress(
        "checking_source",
        "Connecting to the configured database and preparing its validation checks."
      );
    }

    if (awsMode) {
      await reportProgress(
        "selecting_snapshot",
        "Selecting a snapshot, then AWS will provision a temporary validation database."
      );
    } else {
      await reportProgress(
        "running_checks",
        "Running the configured validation checks."
      );
    }
    const { code, stdout, stderr } = await runCommand(
      cliPath,
      ["verify", "-c", configPath, "-o", reportPath, "--markdown", join(dir, "report.md")],
      {
        cwd: dir,
        env,
        timeoutMs,
        label: `job=${claimed.job.id} step=verify`,
        onProgress: reportProgress,
        ...(awsMode
          ? {
              heartbeat: {
                stage: "restoring_sandbox" as const,
                message: "AWS snapshot restore and validation are still running.",
              },
            }
          : {}),
      }
    );

    let report: CliReport = {};
    try {
      report = JSON.parse(await readFile(reportPath, "utf8")) as CliReport;
    } catch {
      report = {};
    }

    const verifyResults = mapCliReport(
      report,
      undefined,
      code !== 0 ? stderr || stdout : undefined
    );
    const connectionCheck = verifyResults.find((result) => result.checkType === "connect");
    console.log(
      `[runner] job=${claimed.job.id} verification report loaded ` +
        `exitCode=${code ?? "unknown"} checks=${verifyResults.length} ` +
        `databaseConnect=${connectionCheck?.status ?? "not reported"} ` +
        `reportStatus=${report.status ?? "missing"}`
    );
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
    if (report.recovery?.snapshot_identifier) {
      const snapshotArn = report.recovery.snapshot_arn
        ? `;snapshot_arn=${report.recovery.snapshot_arn}`
        : "";
      results.push({
        checkName: "recovery_snapshot",
        checkType: "recovery_snapshot",
        status: "pass",
        message: `snapshot_identifier=${report.recovery.snapshot_identifier}${snapshotArn}`,
        durationMs: 0,
      });
    }

    if (httpSpecs.length > 0) {
      results.push(...(await runHttpHealthChecks(httpSpecs)));
    }

    const verifyFailed =
      code !== 0 ||
      report.status?.toUpperCase() === "FAIL" ||
      verifyResults.some((r) => r.status === "fail") ||
      results.some((r) => r.checkType === "http_health" && r.status === "fail");

    const cleanup = report.recovery;
    if (cleanup) {
      results.push(mapCliCleanupResult(cleanup));
    }
    await reportProgress(
      cleanup ? "cleaning_sandbox" : "running_checks",
      cleanup
        ? "Restore validation is complete; checking temporary sandbox cleanup status."
        : "Restore validation checks are complete.",
      results.slice(-100).map((result) => ({
        checkName: result.checkName,
        checkType: result.checkType,
        status: result.status === "error" ? "fail" : result.status,
        message: result.message,
      }))
    );
    const failed = verifyFailed || results.some((r) => r.status === "fail");
    console.log(
      `[runner] job=${claimed.job.id} CLI execution ${failed ? "failed" : "passed"} ` +
        `duration=${Date.now() - started}ms`
    );

    return {
      status: failed ? "fail" : "pass",
      executionMode,
      usedCli: true,
      rtoSeconds:
        report.recovery?.rto_seconds ??
        Math.max(1, Math.round((Date.now() - started) / 1000)),
      errorMessage: failed
        ? (stderr || stdout || "revenant verify failed").slice(0, 500)
        : undefined,
      results,
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function cliUnavailableOutcome(
  executionMode: "stub" | "agent" | "ci",
  reason: string
): ExecutionOutcome {
  const message = `Managed validation did not run because the Revenant CLI is unavailable: ${reason}`;
  return {
    status: "fail",
    executionMode,
    usedCli: false,
    rtoSeconds: 1,
    errorMessage: message,
    results: [{
      checkName: "revenant_cli",
      checkType: "runner",
      status: "fail",
      message,
      durationMs: 0,
    }],
  };
}

/**
 * Execute a claimed job with the real Revenant CLI. Missing CLI is a hard failure.
 */
export async function executeClaimedJob(
  claimed: ClaimedPayload,
  executionMode: "stub" | "agent" | "ci",
  reportProgress: ReportRunnerProgress = async () => {}
): Promise<ExecutionOutcome> {
  await reportProgress(
    "resolving_cli",
    "Checking runner CLI availability and private release access."
  );
  console.log(`[runner] resolving CLI for job=${claimed.job.id} mode=${executionMode}`);
  const cli = await resolveRevenantCli();
  if (!cli) {
    console.error(`[runner] job=${claimed.job.id} cannot execute: Revenant CLI unavailable`);
    return cliUnavailableOutcome(
      executionMode,
      "configure a valid REVENANT_CLI_PATH or provide REVENANT_CLI_GITHUB_TOKEN with access to a published private CLI release"
    );
  }

  return runWithCli(claimed, cli, executionMode, reportProgress);
}
