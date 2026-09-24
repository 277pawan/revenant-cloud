import type { JobDetailResource } from "@revenant/shared";
import { type EmailBrand, escapeHtml, wrapEmailHtml } from "./email-layout.js";

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
  appUrl?: string;
}): string {
  const { label } = eventMeta(ctx.event);
  const appUrl = ctx.appUrl ?? "http://localhost:5173";
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
    `View run: ${appUrl}/workflows/${ctx.job.databaseId}/runs/${ctx.job.id}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function jobAlertHtml(ctx: {
  event: string;
  job: JobDetailResource;
  brand: EmailBrand;
}): string {
  const meta = eventMeta(ctx.event);
  const runUrl = `${ctx.brand.appUrl}/workflows/${ctx.job.databaseId}/runs/${ctx.job.id}`;

  const bodyHtml = `
    <p style="margin:0 0 16px;">
      <strong>${escapeHtml(ctx.job.databaseName)}</strong> finished with status
      <span style="color:${meta.color};font-weight:700;"> ${escapeHtml(ctx.job.status)}</span>.
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:14px;">
      <tr>
        <td style="padding:8px 0;color:#64748b;width:120px;">RTO</td>
        <td style="padding:8px 0;font-weight:600;">${formatRto(ctx.job.rtoSeconds)}</td>
      </tr>
      <tr>
        <td style="padding:8px 0;color:#64748b;">Job</td>
        <td style="padding:8px 0;font-family:ui-monospace,monospace;font-size:12px;">${escapeHtml(ctx.job.id)}</td>
      </tr>
      ${
        ctx.job.finishedAt
          ? `<tr><td style="padding:8px 0;color:#64748b;">Finished</td><td style="padding:8px 0;">${escapeHtml(ctx.job.finishedAt)}</td></tr>`
          : ""
      }
      ${
        ctx.job.errorMessage
          ? `<tr><td style="padding:8px 0;color:#64748b;vertical-align:top;">Details</td><td style="padding:8px 0;color:#b45309;">${escapeHtml(ctx.job.errorMessage)}</td></tr>`
          : ""
      }
    </table>`;

  return wrapEmailHtml({
    brand: ctx.brand,
    eyebrow: "Restore drill",
    title: `${meta.emoji} Drill ${meta.label.toLowerCase()}`,
    bodyHtml,
    cta: { label: "View run details", url: runUrl },
  });
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
  brand: EmailBrand;
}): string {
  const pass = input.passRate7d != null ? `${input.passRate7d}%` : "—";

  const bodyHtml = `
    <p style="margin:0 0 16px;font-size:16px;font-weight:600;color:#0f172a;">
      ${input.healthy}/${input.total} workflows healthy
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;border-collapse:collapse;">
      <tr><td style="color:#64748b;padding:6px 0;">7-day pass rate</td><td style="font-weight:700;padding:6px 0;">${pass}</td></tr>
      <tr><td style="color:#64748b;padding:6px 0;">Avg RTO (7d)</td><td style="font-weight:700;padding:6px 0;">${formatRto(input.avgRtoSeconds7d)}</td></tr>
      <tr><td style="color:#64748b;padding:6px 0;">Needs attention</td><td style="padding:6px 0;">${input.warning}</td></tr>
      <tr><td style="color:#64748b;padding:6px 0;">At risk</td><td style="color:#dc2626;font-weight:600;padding:6px 0;">${input.critical}</td></tr>
      <tr><td style="color:#64748b;padding:6px 0;">Failures (24h)</td><td style="padding:6px 0;">${input.failures24h}</td></tr>
    </table>`;

  return wrapEmailHtml({
    brand: input.brand,
    eyebrow: "Weekly digest",
    title: input.orgName,
    bodyHtml,
    cta: { label: "Open dashboard", url: input.brand.appUrl },
  });
}

export function passwordResetPlainText(resetUrl: string): string {
  return [
    "Reset your Revenant Cloud password",
    "",
    "Open this link (valid for 1 hour):",
    resetUrl,
    "",
    "If you did not request this, you can ignore this email.",
  ].join("\n");
}

export function passwordResetHtml(resetUrl: string, brand: EmailBrand): string {
  return wrapEmailHtml({
    brand,
    eyebrow: "Account security",
    title: "Reset your password",
    bodyHtml: `<p style="margin:0;">Click the button below to choose a new password. This link expires in one hour.</p>
      <p style="margin:16px 0 0;font-size:13px;color:#64748b;">If you didn&apos;t request this, you can safely ignore this email.</p>`,
    cta: { label: "Reset password", url: resetUrl },
  });
}

export function fundingThankYouHtml(input: {
  brand: EmailBrand;
  name: string;
  amountInr: number;
}): string {
  return wrapEmailHtml({
    brand: input.brand,
    eyebrow: "Thank you",
    title: "We received your support",
    bodyHtml: `
      <p style="margin:0 0 12px;">Hi ${escapeHtml(input.name)},</p>
      <p style="margin:0 0 12px;">Thank you for contributing <strong>₹${input.amountInr.toLocaleString("en-IN")}</strong> to Revenant. It helps us build better disaster-recovery tooling for PostgreSQL and AWS.</p>
      <p style="margin:0;color:#64748b;">If you left a note, we read every one. Stars on GitHub help too.</p>`,
    footerNote: "This is a one-time contribution — not a subscription.",
  });
}

export function fundingReceivedHtml(input: {
  brand: EmailBrand;
  name: string;
  email: string;
  amountInr: number;
  note?: string | null;
  paymentId: string;
}): string {
  const note = input.note?.trim()
    ? `<p style="margin:12px 0 0;"><strong>Note:</strong> ${escapeHtml(input.note)}</p>`
    : "";
  return wrapEmailHtml({
    brand: input.brand,
    eyebrow: "Funding",
    title: `₹${input.amountInr.toLocaleString("en-IN")} received`,
    bodyHtml: `
      <p style="margin:0 0 12px;"><strong>Name:</strong> ${escapeHtml(input.name)}</p>
      <p style="margin:0 0 12px;"><strong>Email:</strong> ${escapeHtml(input.email)}</p>
      <p style="margin:0 0 12px;"><strong>Payment ID:</strong> ${escapeHtml(input.paymentId)}</p>
      ${note}`,
    footerNote: "Paid via Razorpay on the marketing Fund us page.",
  });
}

export function contactFormHtml(input: {
  brand: EmailBrand;
  type: "talk" | "coffee";
  name: string;
  email: string;
  message?: string;
  amountInr?: number;
}): string {
  const label = input.type === "coffee" ? "Buy coffee / funding" : "Talk to us";
  const amount =
    input.type === "coffee" && input.amountInr
      ? `<p style="margin:0 0 12px;"><strong>Amount:</strong> ₹${input.amountInr}</p>`
      : "";
  const msg = input.message?.trim()
    ? `<p style="margin:0 0 8px;"><strong>Message</strong></p><p style="margin:0;white-space:pre-wrap;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px;">${escapeHtml(input.message)}</p>`
    : `<p style="margin:0;color:#64748b;"><em>No message provided.</em></p>`;

  return wrapEmailHtml({
    brand: input.brand,
    eyebrow: "Marketing site",
    title: label,
    bodyHtml: `
      <p style="margin:0 0 12px;"><strong>Name:</strong> ${escapeHtml(input.name)}</p>
      <p style="margin:0 0 12px;"><strong>Email:</strong> <a href="mailto:${escapeHtml(input.email)}" style="color:#c9a227;">${escapeHtml(input.email)}</a></p>
      ${amount}
      ${msg}`,
    footerNote: "Sent from the Revenant marketing site contact form.",
  });
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
