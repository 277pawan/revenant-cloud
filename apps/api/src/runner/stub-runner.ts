/**
 * Stub runner — Phase 2.
 * Polls POST /api/v1/runner/claim, simulates checks, POSTs complete.
 * Later: replace simulation with `revenant verify` CLI spawn.
 *
 * Usage (from repo root):
 *   npm run runner:stub -w @revenant/api
 */
import { loadEnv } from "../config/env.js";

const env = loadEnv();
const API = `http://${env.API_HOST === "0.0.0.0" ? "127.0.0.1" : env.API_HOST}:${env.API_PORT}`;
const INTERVAL_MS = 3000;

async function tick() {
  const claimRes = await fetch(`${API}/api/v1/runner/claim`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RUNNER_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: "{}",
  });

  if (claimRes.status === 204) {
    return;
  }

  if (!claimRes.ok) {
    const text = await claimRes.text();
    console.error("Claim failed:", claimRes.status, text);
    return;
  }

  const claimed = (await claimRes.json()) as {
    job: { id: string; databaseName: string };
    database: { host: string | null; username: string | null };
    password: string | null;
    planYaml: string | null;
  };

  console.log(
    `[runner] claimed job ${claimed.job.id} for ${claimed.job.databaseName}`
  );

  const started = Date.now();
  const hasPlan = Boolean(claimed.planYaml);
  const hasHost = Boolean(claimed.database.host);
  const hasPassword = Boolean(claimed.password);

  // Stub: do not call real RDS yet — emit synthetic check results
  const results = [
    {
      checkName: "connect",
      checkType: "connect",
      status: hasHost && hasPassword ? ("pass" as const) : ("fail" as const),
      message: hasHost && hasPassword
        ? `Stub connect OK to ${claimed.database.host} as ${claimed.database.username}`
        : "Missing host or password — configure database credentials",
      durationMs: 120,
    },
    {
      checkName: "validation_plan",
      checkType: "plan",
      status: hasPlan ? ("pass" as const) : ("fail" as const),
      message: hasPlan
        ? "Validation plan present"
        : "No validation plan attached to this database",
      durationMs: 15,
    },
  ];

  const failed = results.some((r) => r.status === "fail");
  const status = failed ? "fail" : "pass";

  const completeRes = await fetch(
    `${API}/api/v1/runner/jobs/${claimed.job.id}/complete`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RUNNER_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        status,
        rtoSeconds: Math.max(1, Math.round((Date.now() - started) / 1000)),
        errorMessage: failed ? "One or more stub checks failed" : undefined,
        results,
      }),
    }
  );

  if (!completeRes.ok) {
    console.error("Complete failed:", completeRes.status, await completeRes.text());
    return;
  }

  console.log(`[runner] completed job ${claimed.job.id} → ${status}`);
}

console.log(`[runner] stub polling ${API} every ${INTERVAL_MS}ms`);
setInterval(() => {
  void tick().catch((err) => console.error(err));
}, INTERVAL_MS);

void tick();
