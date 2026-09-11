import type { DeliverContext, DeliveryResult } from "./types.js";

function eventLabel(event: string): string {
  if (event === "job.pass") return "✅ Validation passed";
  if (event === "job.fail") return "❌ Validation failed";
  if (event === "job.error") return "⚠️ Validation error";
  return event;
}

export async function deliverSlack(ctx: DeliverContext): Promise<DeliveryResult> {
  const webhookUrl = String(ctx.config.webhookUrl ?? "");
  if (!webhookUrl.includes("hooks.slack.com")) {
    return { ok: false, error: "Invalid Slack webhook URL" };
  }

  const text = [
    `*${eventLabel(ctx.event)}*`,
    `Workflow: *${ctx.job.databaseName}*`,
    `Status: \`${ctx.job.status}\``,
    ctx.job.rtoSeconds != null ? `RTO: ${ctx.job.rtoSeconds}s` : null,
    `Job: \`${ctx.job.id}\``,
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(10_000),
    });
    return { ok: res.ok, httpStatus: res.status };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Slack delivery failed",
    };
  }
}
