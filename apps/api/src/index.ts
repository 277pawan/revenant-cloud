import { loadEnv } from "./config/env.js";
import { buildApp } from "./app.js";
import { startRunnerPoll } from "./runner/poll-loop.js";
import { resolveRevenantCli } from "./runner/execute-job.js";
import { startSchedulePoll } from "./scheduler/poll-schedules.js";
import { startWeeklyDigestPoll } from "./scheduler/poll-weekly-digest.js";
import { createJobsService } from "./services/jobs.service.js";
import { createDb } from "./db/index.js";

const env = loadEnv();
console.log(
  `[api] configuration validated — host=${env.API_HOST} port=${env.API_PORT} ` +
    `environment=${env.NODE_ENV} embeddedRunner=${env.EMBEDDED_RUNNER} ` +
    `embeddedScheduler=${env.EMBEDDED_SCHEDULER} ` +
    `cliPath=${process.env.REVENANT_CLI_PATH?.trim() ? "configured" : "not configured"} ` +
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
        (cli ? ` (CLI: ${cli})` : " (CLI unavailable; configure REVENANT_CLI_PATH or private release access)")
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
  } else {
    console.log(
      "[embedded-scheduler] off — set EMBEDDED_SCHEDULER=true to poll schedules"
    );
  }
} catch (err) {
  console.error("[api] startup failed:", err);
  process.exit(1);
}
