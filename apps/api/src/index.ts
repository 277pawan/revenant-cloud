import { loadEnv } from "./config/env.js";
import { buildApp } from "./app.js";
import { startRunnerPoll } from "./runner/poll-loop.js";
import {
  getCliResolutionDetails,
  resolveRevenantCli,
} from "./runner/execute-job.js";
import { startSchedulePoll } from "./scheduler/poll-schedules.js";
import { startWeeklyDigestPoll } from "./scheduler/poll-weekly-digest.js";
import { startRedisSnapshotSweep } from "./scheduler/redis-snapshot-sweep.js";
import { startRedisProofWorker } from "./scheduler/redis-proof-worker.js";
import { createJobsService } from "./services/jobs.service.js";
import { createDb } from "./db/index.js";

const env = loadEnv();
console.log(
  `[api] configuration validated — host=${env.API_HOST} port=${env.API_PORT} ` +
    `environment=${env.NODE_ENV} embeddedRunner=${env.EMBEDDED_RUNNER} ` +
    `embeddedScheduler=${env.EMBEDDED_SCHEDULER} ` +
    `redisProofWorker=${env.REDIS_PROOF_WORKER_ENABLED} ` +
    `githubReleaseToken=${process.env.REVENANT_CLI_GITHUB_TOKEN?.trim() ? "configured" : "not configured"}`
);
console.log("[api] building application...");
const app = await buildApp(env);
console.log("[api] application built; checking database connection...");

try {
  const dbCheckStartedAt = Date.now();
  try {
    await app.db.$client.query("SELECT 1");
    console.log(`[api] database connected (${Date.now() - dbCheckStartedAt}ms)`);
  } catch (err) {
    console.error(
      `[api] database connection failed after ${Date.now() - dbCheckStartedAt}ms; ` +
        "the API will start, but database-backed requests may fail:",
      err instanceof Error ? err.message : err
    );
  }

  console.log(`[api] starting HTTP server on ${env.API_HOST}:${env.API_PORT}...`);
  await app.listen({ port: env.API_PORT, host: env.API_HOST });
  console.log(`API listening on http://${env.API_HOST}:${env.API_PORT}`);

  if (env.EMBEDDED_RUNNER) {
    const apiBase = `http://${env.API_HOST === "0.0.0.0" ? "127.0.0.1" : env.API_HOST}:${env.API_PORT}`;
    console.log("[embedded-runner] resolving Revenant CLI...");
    const cli = await resolveRevenantCli();
    console.log(
      `[embedded-runner] enabled — mode=stub jobs will be claimed automatically` +
        (cli
          ? ` (CLI: ${cli}; release=${getCliResolutionDetails().release})`
          : " (CLI unavailable; configure GitHub release access)")
    );
    startRunnerPoll({
      apiBase,
      token: env.RUNNER_TOKEN,
      executionMode: "stub",
      label: "embedded",
      intervalMs: Number(process.env.REVENANT_POLL_MS ?? 2000),
    });
  } else {
    console.log(
      "[embedded-runner] off — no jobs will be claimed by this API process; " +
        "start a runner or set EMBEDDED_RUNNER=true"
    );
  }

  if (env.EMBEDDED_SCHEDULER) {
    console.log("[embedded-scheduler] initializing schedule polling...");
    const db = createDb(env.DATABASE_URL);
    const jobsService = createJobsService(db, env.MASTER_KEY);
    startSchedulePoll({
      db,
      jobsService,
      intervalMs: Number(process.env.SCHEDULER_POLL_MS ?? 60_000),
      label: "embedded",
    });
    console.log("[embedded-scheduler] enabled — due schedules enqueue jobs");
    startWeeklyDigestPoll({ db, env, label: "embedded" });
    console.log("[weekly-digest] enabled — Mondays 09:00 UTC");
    startRedisSnapshotSweep({ db, label: "embedded" });
  } else {
    console.log(
      "[embedded-scheduler] off — set EMBEDDED_SCHEDULER=true to poll schedules"
    );
  }

  // The managed Redis proof worker.
  //
  // Redis restore proofs used to have exactly ONE executor: a self-hosted
  // agent. That made an always-on customer-operated service a hidden
  // prerequisite of a dashboard button, and every proof in a deployment
  // without one sat in `pending` until it was failed with "No Redis proof
  // worker claimed this run".
  //
  // This is the second executor, and it lives here on purpose: the API
  // already reaches the customer's Redis for the URL probe, so it can host
  // the restore sandbox too. Self-hosted agents keep working and still take
  // over for Redis inside a private network the cloud cannot route to.
  if (env.REDIS_PROOF_WORKER_ENABLED) {
    const db = createDb(env.DATABASE_URL);
    startRedisProofWorker({
      db,
      masterKey: env.MASTER_KEY,
      concurrency: env.REDIS_PROOF_WORKER_CONCURRENCY,
      intervalMs: env.REDIS_PROOF_POLL_MS,
      maxIdleIntervalMs: env.REDIS_PROOF_MAX_IDLE_MS,
      maxInFlight: env.REDIS_PROOF_MAX_INFLIGHT,
      sampleSize: env.REDIS_PROOF_SAMPLE_SIZE,
      maxMemory: env.REDIS_PROOF_MAX_MEMORY,
      timeoutMs: env.REDIS_PROOF_TIMEOUT_MS,
      serverBin: env.REDIS_PROOF_SERVER_BIN,
      cliBin: env.REDIS_PROOF_CLI_BIN,
      label: "redis-proof-worker",
    });
    console.log(
      "[redis-proof-worker] enabled — Redis restore proofs run in this process; " +
        "self-hosted agents still serve private-network Redis"
    );
  } else {
    console.log(
      "[redis-proof-worker] off — Redis proofs will only run on a self-hosted agent"
    );
  }
} catch (err) {
  console.error("[api] startup failed:", err);
  process.exit(1);
}
