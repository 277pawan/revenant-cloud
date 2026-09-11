/**
 * Org agent runner — for customer/self-hosted boxes (or CI with kind=ci token).
 * Local SaaS demo: you usually do NOT need this — API embeds a worker on `npm run dev`.
 *
 *   REVENANT_API_URL=http://127.0.0.1:8080 \
 *   REVENANT_RUNNER_TOKEN=rvn_... \
 *   npm run runner:agent -w @revenant/api
 */
import { loadEnv } from "../config/env.js";
import { startRunnerPoll } from "./poll-loop.js";

const env = loadEnv();
const API = process.env.REVENANT_API_URL ?? `http://127.0.0.1:${env.API_PORT}`;
const TOKEN = process.env.REVENANT_RUNNER_TOKEN;

if (!TOKEN) {
  console.error(
    "Set REVENANT_RUNNER_TOKEN to an org runner token from Settings → Runners"
  );
  process.exit(1);
}

const kind = (process.env.REVENANT_RUNNER_KIND ?? "agent") as "agent" | "ci";

startRunnerPoll({
  apiBase: API,
  token: TOKEN,
  executionMode: kind === "ci" ? "ci" : "agent",
  label: kind,
  intervalMs: Number(process.env.REVENANT_POLL_MS ?? 3000),
});
