import { loadEnv } from "./config/env.js";
import { buildApp } from "./app.js";
import { startRunnerPoll } from "./runner/poll-loop.js";
import { resolveRevenantCli } from "./runner/execute-job.js";
import { startSchedulePoll } from "./scheduler/poll-schedules.js";
import { createJobsService } from "./services/jobs.service.js";
import { createDb } from "./db/index.js";

const env = loadEnv();
const app = await buildApp(env);

try {
  await app.listen({ port: env.API_PORT, host: env.API_HOST });
  console.log(`API listening on http://${env.API_HOST}:${env.API_PORT}`);

  if (env.EMBEDDED_RUNNER) {
    const apiBase = `http://${env.API_HOST === "0.0.0.0" ? "127.0.0.1" : env.API_HOST}:${env.API_PORT}`;
    const cli = await resolveRevenantCli();
    console.log(
      `[embedded-runner] enabled — jobs will be claimed automatically` +
        (cli ? ` (CLI: ${cli})` : " (CLI not found → metadata fallback; set REVENANT_CLI_PATH)")
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
      "[embedded-runner] off — start runner:stub / runner:agent, or set EMBEDDED_RUNNER=true"
    );
  }

  if (env.EMBEDDED_SCHEDULER) {
    const db = createDb(env.DATABASE_URL);
    const jobsService = createJobsService(db, env.MASTER_KEY);
    startSchedulePoll({
      db,
      jobsService,
      intervalMs: Number(process.env.SCHEDULER_POLL_MS ?? 60_000),
      label: "embedded",
    });
    console.log("[embedded-scheduler] enabled — due schedules enqueue jobs");
  } else {
    console.log(
      "[embedded-scheduler] off — set EMBEDDED_SCHEDULER=true to poll schedules"
    );
  }
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
