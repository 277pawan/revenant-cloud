import type { DeliverContext, DeliveryResult } from "./types.js";
import { buildSlackJobBlocks } from "../lib/notification-templates.js";

export async function deliverSlack(
  ctx: DeliverContext
): Promise<DeliveryResult> {
  const webhookUrl = String(ctx.config.webhookUrl ?? "");
  if (!webhookUrl.includes("hooks.slack.com")) {
    return { ok: false, error: "Invalid Slack webhook URL" };
  }

  const payload = buildSlackJobBlocks({
    event: ctx.event,
    job: ctx.job,
    appUrl: ctx.appUrl,
  });

  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
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
