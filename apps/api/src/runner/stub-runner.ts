/**
 * Standalone stub runner (optional). Prefer EMBEDDED_RUNNER with `npm run dev`.
 *
 *   npm run runner:stub -w @revenant/api
 */
import { loadEnv } from "../config/env.js";
import { startRunnerPoll } from "./poll-loop.js";

const env = loadEnv();
const API = `http://${env.API_HOST === "0.0.0.0" ? "127.0.0.1" : env.API_HOST}:${env.API_PORT}`;

startRunnerPoll({
  apiBase: API,
  token: env.RUNNER_TOKEN,
  executionMode: "stub",
  label: "stub",
  intervalMs: Number(process.env.REVENANT_POLL_MS ?? 3000),
});
