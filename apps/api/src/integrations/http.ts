import { createHmac } from "node:crypto";
import type { DeliverContext, DeliveryResult } from "./types.js";

export async function deliverHttp(ctx: DeliverContext): Promise<DeliveryResult> {
  const url = String(ctx.config.url ?? ctx.endpoint.url ?? "");
  if (!url.startsWith("http")) {
    return { ok: false, error: "Invalid HTTP webhook URL" };
  }

  const body = JSON.stringify({
    event: ctx.event,
    job: {
      id: ctx.job.id,
      databaseId: ctx.job.databaseId,
      databaseName: ctx.job.databaseName,
      status: ctx.job.status,
      trigger: ctx.job.trigger,
      finishedAt: ctx.job.finishedAt,
      rtoSeconds: ctx.job.rtoSeconds,
    },
    sentAt: new Date().toISOString(),
  });

  const signature = createHmac("sha256", ctx.endpoint.secret)
    .update(body)
    .digest("hex");

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Revenant-Signature": `sha256=${signature}`,
        "X-Revenant-Event": ctx.event,
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    return { ok: res.ok, httpStatus: res.status };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "HTTP delivery failed",
    };
  }
}
