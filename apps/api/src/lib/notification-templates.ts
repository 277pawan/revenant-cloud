import type { JobDetailResource } from "@revenant/shared";
import {
  type EmailBrand,
  type EmailTone,
  emailCallout,
  emailHealthBar,
  emailKeyValueTable,
  emailMetricTiles,
  emailStatusBadge,
  escapeHtml,
  formatEmailDateTime,
  wrapEmailHtml,
} from "./email-layout.js";

function eventMeta(event: string) {
  if (event === "job.pass") {
    return { label: "Passed", emoji: "✅", color: "#059669", tone: "success" as EmailTone };
  }
  if (event === "job.fail") {
    return { label: "Failed", emoji: "❌", color: "#dc2626", tone: "danger" as EmailTone };
  }
  if (event === "contract.breach") {
    return {
      label: "Contract breach",
      emoji: "🚨",
      color: "#c2410c",
      tone: "warning" as EmailTone,
    };
  }
  if (event === "contract.regression") {
    return {
      label: "Regression",
      emoji: "📉",
      color: "#b45309",
      tone: "warning" as EmailTone,
    };
  }
  return { label: "Error", emoji: "⚠️", color: "#d97706", tone: "warning" as EmailTone };
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
  const title =
    ctx.event === "contract.breach"
      ? `${meta.emoji} Recovery targets missed`
      : ctx.event === "contract.regression"
        ? `${meta.emoji} Recovery regression detected`
        : `${meta.emoji} Restore drill ${meta.label.toLowerCase()}`;

  const intro =
    ctx.event === "contract.breach"
      ? `<p style="margin:0 0 16px;">Checks passed for <strong>${escapeHtml(ctx.job.databaseName)}</strong>, but measured recovery time or data age exceeded your contract.</p>`
      : ctx.event === "contract.regression"
        ? `<p style="margin:0 0 16px;">Checks passed for <strong>${escapeHtml(ctx.job.databaseName)}</strong>, but RTO, RPO, or readiness score worsened compared to the prior drill.</p>`
        : `<p style="margin:0 0 16px;">A restore drill finished for <strong>${escapeHtml(ctx.job.databaseName)}</strong>.</p>`;

  const bodyHtml = `
    <p style="margin:0 0 14px;">${emailStatusBadge(meta.label, meta.tone)}</p>
    ${intro}
    ${emailMetricTiles([
      { label: "Recovery time", value: formatRto(ctx.job.rtoSeconds) },
      { label: "Result", value: ctx.job.status, tone: meta.tone },
    ])}
    ${emailKeyValueTable([
      { label: "Workflow", value: ctx.job.databaseName },
      { label: "Finished", value: ctx.job.finishedAt ? formatEmailDateTime(ctx.job.finishedAt) : "—" },
      { label: "Run ID", value: ctx.job.id, mono: true },
      ...(ctx.job.errorMessage
        ? [
            {
              label:
                ctx.event === "contract.breach" || ctx.event === "contract.regression"
                  ? "Details"
                  : "Details",
              value: ctx.job.errorMessage,
              valueColor: "#b45309",
            },
          ]
        : []),
    ])}
    ${
      ctx.event === "contract.breach" || ctx.event === "contract.regression"
        ? emailCallout(
            ctx.event === "contract.breach"
              ? "Update your recovery contract or improve drill performance before your next scheduled run."
              : "Investigate what changed since the last drill — schema drift, infra, or data volume often explain regression.",
            "warning"
          )
        : ""
    }`;

  return wrapEmailHtml({
    brand: ctx.brand,
    eyebrow:
      ctx.event === "contract.breach"
        ? "SLA alert"
        : ctx.event === "contract.regression"
          ? "Regression alert"
          : "Restore drill",
    title,
    bodyHtml,
    cta: { label: "View run & evidence", url: runUrl },
    secondaryCta: { label: "Open dashboard", url: ctx.brand.appUrl },
    footerNote: "Alerts are sent when integrations subscribe to drill events.",
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
  const passTone =
    input.passRate7d == null
      ? "neutral"
      : input.passRate7d >= 90
        ? "success"
        : input.passRate7d >= 70
          ? "warning"
          : "danger";

  const bodyHtml = `
    <p style="margin:0 0 6px;font-size:15px;color:#334155;">Here is how <strong>${escapeHtml(input.orgName)}</strong> performed this week.</p>
    <p style="margin:0 0 18px;font-size:13px;color:#64748b;">Fleet posture, drill success rate, and recovery speed at a glance.</p>
    ${emailHealthBar(input)}
    ${emailMetricTiles([
      { label: "Drills passed (7d)", value: pass, tone: passTone as EmailTone },
      { label: "Avg recovery time", value: formatRto(input.avgRtoSeconds7d) },
      {
        label: "Failures (24h)",
        value: String(input.failures24h),
        tone: input.failures24h > 0 ? "danger" : "success",
      },
    ])}
    ${emailKeyValueTable([
      { label: "Healthy workflows", value: String(input.healthy) },
      { label: "Need attention", value: String(input.warning) },
      { label: "At risk", value: String(input.critical), valueColor: input.critical > 0 ? "#dc2626" : undefined },
      { label: "Total tracked", value: String(input.total) },
    ])}
    ${
      input.total === 0
        ? ""
        : input.critical > 0 || input.failures24h > 0
          ? emailCallout(
              "Some workflows need a restore drill or configuration fix. Open the dashboard to see which ones.",
              "warning"
            )
          : emailCallout(
              "Your fleet looks healthy. Keep the weekly schedule running for continuous proof.",
              "success"
            )
    }`;

  return wrapEmailHtml({
    brand: input.brand,
    eyebrow: "Weekly digest",
    title: "Your recovery posture",
    bodyHtml,
    cta: { label: "Review fleet dashboard", url: input.brand.appUrl },
    footerNote: "Sent every Monday to organization admins.",
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
    bodyHtml: `
      <p style="margin:0 0 12px;">We received a request to reset the password for your Revenant Cloud account.</p>
      <ol style="margin:0;padding-left:20px;color:#475569;font-size:14px;line-height:1.7;">
        <li>Click the button below (valid for <strong>1 hour</strong>).</li>
        <li>Choose a new password on the secure page.</li>
        <li>Sign in again with your new credentials.</li>
      </ol>
      ${emailCallout("If you did not request this, ignore this email — your password will not change.", "info")}`,
    cta: { label: "Reset password", url: resetUrl },
    footerNote: "For security, this link can only be used once.",
  });
}

export function teamInvitePlainText(input: {
  organizationName: string;
  role: string;
  inviteUrl: string;
  expiresAt: string;
}): string {
  return [
    `You're invited to ${input.organizationName} on Revenant Cloud`,
    "",
    `Role: ${input.role}`,
    "",
    "Accept the invite (expires in 7 days):",
    input.inviteUrl,
    "",
    `Expires: ${input.expiresAt}`,
  ].join("\n");
}

export function teamInviteHtml(input: {
  brand: EmailBrand;
  organizationName: string;
  role: string;
  inviteUrl: string;
  expiresAt: string;
}): string {
  return wrapEmailHtml({
    brand: input.brand,
    eyebrow: "Team invite",
    title: `Join ${input.organizationName}`,
    bodyHtml: `
      <p style="margin:0 0 14px;">You've been invited to collaborate on restore drills and evidence for <strong>${escapeHtml(input.organizationName)}</strong>.</p>
      ${emailMetricTiles([
        { label: "Organization", value: input.organizationName },
        { label: "Your role", value: input.role },
      ])}
      ${emailCallout(`This invite expires on ${formatEmailDateTime(input.expiresAt)}.`, "info")}`,
    cta: { label: "Accept invite", url: input.inviteUrl },
    footerNote: "Revenant helps teams prove backups actually restore.",
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

  const headerText =
    ctx.event === "contract.breach"
      ? `${meta.emoji} Recovery contract breach`
      : ctx.event === "contract.regression"
        ? `${meta.emoji} Recovery regression`
        : `${meta.emoji} Restore drill ${meta.label}`;

  return {
    text: `${meta.emoji} ${ctx.job.databaseName} — ${meta.label} (RTO ${formatRto(ctx.job.rtoSeconds)})`,
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: headerText, emoji: true },
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
