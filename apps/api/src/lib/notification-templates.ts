import type { JobDetailResource } from "@revenant/shared";

const BRAND = "#2563eb";

function eventMeta(event: string) {
  if (event === "job.pass") {
    return { label: "Passed", emoji: "✅", color: "#059669" };
  }
  if (event === "job.fail") {
    return { label: "Failed", emoji: "❌", color: "#dc2626" };
  }
  return { label: "Error", emoji: "⚠️", color: "#d97706" };
}

function formatRto(seconds: number | null | undefined): string {
  if (seconds == null) return "—";
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

export function jobAlertSubject(event: string, workflow: string): string {
  const { label } = eventMeta(event);
  return `[Revenant] ${workflow} — ${label}`;
}

export function jobAlertPlainText(ctx: {
  event: string;
  job: JobDetailResource;
}): string {
  const { label } = eventMeta(ctx.event);
  return [
    `Revenant restore drill — ${label}`,
    "",
    `Workflow: ${ctx.job.databaseName}`,
    `Status: ${ctx.job.status}`,
    `RTO: ${formatRto(ctx.job.rtoSeconds)}`,
    `Job ID: ${ctx.job.id}`,
    ctx.job.finishedAt ? `Finished: ${ctx.job.finishedAt}` : null,
    ctx.job.errorMessage ? `Details: ${ctx.job.errorMessage}` : null,
    "",
    "Open Revenant Cloud to view evidence and fleet health.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function jobAlertHtml(ctx: {
  event: string;
  job: JobDetailResource;
  appUrl?: string;
}): string {
  const meta = eventMeta(ctx.event);
  const appUrl = ctx.appUrl ?? "http://localhost:5173";

  return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:IBM Plex Sans,Inter,Segoe UI,sans-serif;color:#0f172a;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;">
    <tr><td align="center">
      <table width="100%" style="max-width:520px;background:#fff;border-radius:12px;border:1px solid #e2e8f0;overflow:hidden;">
        <tr>
          <td style="background:${BRAND};padding:20px 24px;color:#fff;">
            <div style="font-size:13px;opacity:.9;letter-spacing:.04em;text-transform:uppercase;">Revenant Cloud</div>
            <div style="font-size:22px;font-weight:700;margin-top:6px;">${meta.emoji} Restore drill ${meta.label.toLowerCase()}</div>
          </td>
        </tr>
        <tr>
          <td style="padding:24px;">
            <p style="margin:0 0 16px;font-size:15px;line-height:1.5;">
              <strong>${ctx.job.databaseName}</strong> finished with status
              <span style="color:${meta.color};font-weight:700;"> ${ctx.job.status}</span>.
            </p>
            <table width="100%" style="border-collapse:collapse;font-size:14px;">
              <tr>
                <td style="padding:8px 0;color:#64748b;width:120px;">RTO</td>
                <td style="padding:8px 0;font-weight:600;">${formatRto(ctx.job.rtoSeconds)}</td>
              </tr>
              <tr>
                <td style="padding:8px 0;color:#64748b;">Job</td>
                <td style="padding:8px 0;font-family:monospace;font-size:12px;">${ctx.job.id}</td>
              </tr>
              ${
                ctx.job.finishedAt
                  ? `<tr><td style="padding:8px 0;color:#64748b;">Finished</td><td style="padding:8px 0;">${ctx.job.finishedAt}</td></tr>`
                  : ""
              }
              ${
                ctx.job.errorMessage
                  ? `<tr><td style="padding:8px 0;color:#64748b;vertical-align:top;">Details</td><td style="padding:8px 0;color:#b45309;">${ctx.job.errorMessage}</td></tr>`
                  : ""
              }
            </table>
            <p style="margin:24px 0 0;">
              <a href="${appUrl}/workflows/${ctx.job.databaseId}/runs/${ctx.job.id}"
                 style="display:inline-block;background:${BRAND};color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;font-size:14px;">
                View run details
              </a>
            </p>
          </td>
        </tr>
        <tr>
          <td style="padding:16px 24px;background:#f8fafc;border-top:1px solid #e2e8f0;font-size:12px;color:#64748b;">
            Backups aren&apos;t the product. Recovery is.
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

export function weeklyDigestPlainText(input: {
  orgName: string;
  passRate7d: number | null;
  avgRtoSeconds7d: number | null;
  healthy: number;
  warning: number;
  critical: number;
  total: number;
  failures24h: number;
  appUrl?: string;
}): string {
  const pass =
    input.passRate7d != null ? `${input.passRate7d}% passed (7d)` : "No drills in the last 7 days";
  const rto =
    input.avgRtoSeconds7d != null
      ? `Average RTO: ${formatRto(input.avgRtoSeconds7d)}`
      : "Average RTO: —";

  return [
    `Revenant weekly digest — ${input.orgName}`,
    "",
    `Fleet: ${input.healthy} healthy · ${input.warning} needs attention · ${input.critical} at risk`,
    `Workflows tracked: ${input.total}`,
    pass,
    rto,
    `Failures in last 24h: ${input.failures24h}`,
    "",
    `Open your dashboard: ${input.appUrl ?? "http://localhost:5173"}`,
  ].join("\n");
}

export function weeklyDigestHtml(input: {
  orgName: string;
  passRate7d: number | null;
  avgRtoSeconds7d: number | null;
  healthy: number;
  warning: number;
  critical: number;
  total: number;
  failures24h: number;
  appUrl?: string;
}): string {
  const appUrl = input.appUrl ?? "http://localhost:5173";
  const pass =
    input.passRate7d != null ? `${input.passRate7d}%` : "—";

  return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:IBM Plex Sans,Inter,Segoe UI,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;">
    <tr><td align="center">
      <table width="100%" style="max-width:520px;background:#fff;border-radius:12px;border:1px solid #e2e8f0;">
        <tr>
          <td style="background:${BRAND};padding:20px 24px;color:#fff;">
            <div style="font-size:13px;opacity:.9;">Weekly DR digest</div>
            <div style="font-size:22px;font-weight:700;margin-top:6px;">${input.orgName}</div>
          </td>
        </tr>
        <tr>
          <td style="padding:24px;font-size:14px;color:#0f172a;line-height:1.6;">
            <p style="margin:0 0 16px;font-size:16px;font-weight:600;">${input.healthy}/${input.total} workflows healthy</p>
            <table width="100%" style="font-size:14px;">
              <tr><td style="color:#64748b;padding:6px 0;">7-day pass rate</td><td style="font-weight:700;">${pass}</td></tr>
              <tr><td style="color:#64748b;padding:6px 0;">Avg RTO (7d)</td><td style="font-weight:700;">${formatRto(input.avgRtoSeconds7d)}</td></tr>
              <tr><td style="color:#64748b;padding:6px 0;">Needs attention</td><td>${input.warning}</td></tr>
              <tr><td style="color:#64748b;padding:6px 0;">At risk</td><td style="color:#dc2626;font-weight:600;">${input.critical}</td></tr>
              <tr><td style="color:#64748b;padding:6px 0;">Failures (24h)</td><td>${input.failures24h}</td></tr>
            </table>
            <p style="margin:24px 0 0;">
              <a href="${appUrl}" style="display:inline-block;background:${BRAND};color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;">Open dashboard</a>
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

export function passwordResetPlainText(resetUrl: string): string {
  return [
    "Reset your Revenant Cloud password",
    "",
    `Open this link (valid for 1 hour):`,
    resetUrl,
    "",
    "If you did not request this, you can ignore this email.",
  ].join("\n");
}

export function passwordResetHtml(resetUrl: string): string {
  return `<!DOCTYPE html>
<html><body style="font-family:IBM Plex Sans,Inter,sans-serif;background:#f1f5f9;padding:32px;">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:12px;padding:24px;border:1px solid #e2e8f0;">
    <h1 style="margin:0 0 12px;font-size:20px;color:#0f172a;">Reset your password</h1>
    <p style="color:#475569;line-height:1.5;">Click the button below to choose a new password. This link expires in one hour.</p>
    <p style="margin:24px 0;">
      <a href="${resetUrl}" style="background:${BRAND};color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600;">Reset password</a>
    </p>
    <p style="font-size:12px;color:#94a3b8;">If you didn&apos;t request this, ignore this email.</p>
  </div>
</body></html>`;
}

export function buildSlackJobBlocks(ctx: {
  event: string;
  job: JobDetailResource;
  appUrl?: string;
}) {
  const meta = eventMeta(ctx.event);
  const appUrl = ctx.appUrl ?? "http://localhost:5173";
  const runUrl = `${appUrl}/workflows/${ctx.job.databaseId}/runs/${ctx.job.id}`;

  return {
    text: `${meta.emoji} ${ctx.job.databaseName} — ${meta.label} (RTO ${formatRto(ctx.job.rtoSeconds)})`,
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: `${meta.emoji} Restore drill ${meta.label}`, emoji: true },
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Workflow*\n${ctx.job.databaseName}` },
          { type: "mrkdwn", text: `*Status*\n\`${ctx.job.status}\`` },
          { type: "mrkdwn", text: `*RTO*\n${formatRto(ctx.job.rtoSeconds)}` },
          { type: "mrkdwn", text: `*Job*\n\`${ctx.job.id.slice(0, 8)}…\`` },
        ],
      },
      ...(ctx.job.errorMessage
        ? [
            {
              type: "section",
              text: { type: "mrkdwn", text: `*Details*\n${ctx.job.errorMessage}` },
            },
          ]
        : []),
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "View run", emoji: true },
            url: runUrl,
            style: ctx.event === "job.pass" ? "primary" : "danger",
          },
        ],
      },
    ],
  };
}
