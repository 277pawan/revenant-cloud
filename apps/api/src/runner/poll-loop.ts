/**
 * Shared poll loop — Agent Box, embedded API worker, stub script.
 */
import {
  executeClaimedJob,
  type ClaimedPayload,
  type ExecutionOutcome,
  type ReportRunnerProgress,
} from "./execute-job.js";
import { withRunnerExecutionLock } from "./execution-lock.js";

export type RunnerPollOptions = {
  apiBase: string;
  token: string;
  executionMode: "stub" | "agent" | "ci";
  intervalMs?: number;
  label?: string;
};

type RunnerPollExecutionOptions = RunnerPollOptions & {
  hasReportedApiConnection(): boolean;
  reportApiConnection(): void;
};

async function claimAndComplete(opts: RunnerPollExecutionOptions): Promise<void> {
  const label = opts.label ?? opts.executionMode;
  const claimRes = await fetch(`${opts.apiBase}/api/v1/runner/claim`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.token}`,
      "Content-Type": "application/json",
    },
    body: "{}",
    signal: AbortSignal.timeout(15_000),
  });

  if (claimRes.status === 204) {
    if (!opts.hasReportedApiConnection()) {
      console.log(`[${label}] API reachable; no queued jobs`);
      opts.reportApiConnection();
    }
    return;
  }

  if (!claimRes.ok) {
    console.error(
      `[${opts.label ?? opts.executionMode}] claim failed:`,
      claimRes.status,
      await claimRes.text()
    );
    return;
  }
  if (!opts.hasReportedApiConnection()) {
    console.log(`[${label}] API reachable; runner authenticated`);
    opts.reportApiConnection();
  }

  const claimed = (await claimRes.json()) as ClaimedPayload & {
    executionMode?: string;
  };

  console.log(
    `[${label}] claimed job=${claimed.job.id} database=${claimed.job.databaseName} ` +
      `runnerMode=${opts.executionMode}`
  );

  const reportProgress: ReportRunnerProgress = async (stage, message, checks) => {
    try {
      const progressRes = await fetch(
        `${opts.apiBase}/api/v1/runner/jobs/${claimed.job.id}/progress`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${opts.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ stage, message, ...(checks ? { checks } : {}) }),
          signal: AbortSignal.timeout(5_000),
        }
      );
      if (progressRes.ok) return;
      console.error(
        `[${label}] progress update failed job=${claimed.job.id} stage=${stage}: ` +
          `${progressRes.status} ${await progressRes.text()}`
      );
    } catch (error) {
      console.error(
        `[${label}] progress update failed job=${claimed.job.id} stage=${stage}:`,
        error instanceof Error ? error.message : error
      );
    }
  };
  const outcome: ExecutionOutcome = await executeClaimedJob(
    claimed,
    opts.executionMode,
    reportProgress
  );

  const completeRes = await fetch(
    `${opts.apiBase}/api/v1/runner/jobs/${claimed.job.id}/complete`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        status: outcome.status,
        executionMode: outcome.usedCli
          ? opts.executionMode === "stub"
            ? "agent"
            : opts.executionMode
          : outcome.executionMode,
        rtoSeconds: outcome.rtoSeconds,
        errorMessage: outcome.errorMessage,
        results: outcome.results,
      }),
      signal: AbortSignal.timeout(15_000),
    }
  );

  if (!completeRes.ok) {
    console.error(
      `[${opts.label ?? opts.executionMode}] complete failed:`,
      completeRes.status,
      await completeRes.text()
    );
    return;
  }

  console.log(
    `[${label}] completed job=${claimed.job.id} status=${outcome.status}` +
      (outcome.usedCli ? " (revenant verify)" : " (CLI unavailable)")
  );
}

export function startRunnerPoll(opts: RunnerPollOptions): () => void {
  const intervalMs = opts.intervalMs ?? 3000;
  const label = opts.label ?? opts.executionMode;
  let apiConnectionReported = false;
  const pollOptions = {
    ...opts,
    hasReportedApiConnection: () => apiConnectionReported,
    reportApiConnection: () => {
      apiConnectionReported = true;
    },
  };
  console.log(
    `[${label}] runner starting mode=${opts.executionMode}; checking API at ` +
      `${opts.apiBase}/api/v1/runner/claim every ${intervalMs}ms`
  );

  const tick = () => {
    void withRunnerExecutionLock(() => claimAndComplete(pollOptions))
      .then((ran) => {
        if (ran === null) {
          // Another drill is still running on this API instance — skip this poll tick.
        }
      })
      .catch((err) => {
        console.error(
          `[${label}] API poll or job execution failed:`,
          err instanceof Error ? err.message : err
        );
      });
  };

  tick();
  const id = setInterval(tick, intervalMs);
  return () => clearInterval(id);
}
