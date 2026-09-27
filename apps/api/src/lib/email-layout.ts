import type { Env } from "../config/env.js";

const BRAND_GOLD = "#c9a227";
const BRAND_DARK = "#0f1419";
const BRAND_TEXT = "#0f172a";
const BRAND_MUTED = "#64748b";
const BRAND_BORDER = "#e2e8f0";
const BRAND_BG = "#f1f5f9";

export type EmailBrand = {
  logoUrl: string;
  appUrl: string;
  marketingUrl?: string;
};

export type EmailTone = "success" | "danger" | "warning" | "neutral" | "info";

const TONE_STYLES: Record<EmailTone, { bg: string; text: string; border: string }> = {
  success: { bg: "#ecfdf5", text: "#047857", border: "#a7f3d0" },
  danger: { bg: "#fef2f2", text: "#b91c1c", border: "#fecaca" },
  warning: { bg: "#fffbeb", text: "#b45309", border: "#fde68a" },
  neutral: { bg: "#f8fafc", text: "#475569", border: "#e2e8f0" },
  info: { bg: "#eff6ff", text: "#1d4ed8", border: "#bfdbfe" },
};

export function emailBrandFromUrls(
  appUrl: string,
  marketingUrl?: string,
  logoUrl?: string
): EmailBrand {
  const app = appUrl.replace(/\/$/, "");
  const marketing = marketingUrl?.replace(/\/$/, "");
  return {
    logoUrl:
      logoUrl?.trim() ||
      (marketing ? `${marketing}/revenant_logo.png` : `${app}/revenant_logo.png`),
    appUrl: app,
    marketingUrl: marketing,
  };
}

export function resolveEmailBrand(
  env: Pick<Env, "PUBLIC_APP_URL" | "PUBLIC_MARKETING_URL" | "PUBLIC_EMAIL_LOGO_URL">
): EmailBrand {
  return emailBrandFromUrls(
    env.PUBLIC_APP_URL,
    env.PUBLIC_MARKETING_URL,
    env.PUBLIC_EMAIL_LOGO_URL
  );
}

export type EmailLayoutInput = {
  brand: EmailBrand;
  eyebrow?: string;
  title: string;
  bodyHtml: string;
  cta?: { label: string; url: string };
  secondaryCta?: { label: string; url: string };
  footerNote?: string;
};

/** Colored status pill for alert emails */
export function emailStatusBadge(label: string, tone: EmailTone): string {
  const s = TONE_STYLES[tone];
  return `<span style="display:inline-block;padding:6px 12px;border-radius:999px;font-size:12px;font-weight:700;letter-spacing:0.02em;background:${s.bg};color:${s.text};border:1px solid ${s.border};">${escapeHtml(label)}</span>`;
}

/** 2–4 headline metrics in a responsive row */
export function emailMetricTiles(
  metrics: Array<{ label: string; value: string; tone?: EmailTone }>
): string {
  const cells = metrics
    .map((m) => {
      const accent = m.tone ? TONE_STYLES[m.tone].text : BRAND_TEXT;
      return `<td style="width:${Math.floor(100 / metrics.length)}%;padding:12px 8px;vertical-align:top;">
        <div style="background:#f8fafc;border:1px solid ${BRAND_BORDER};border-radius:12px;padding:14px 12px;text-align:center;">
          <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:${BRAND_MUTED};margin-bottom:6px;">${escapeHtml(m.label)}</div>
          <div style="font-size:22px;font-weight:800;line-height:1.2;color:${accent};">${escapeHtml(m.value)}</div>
        </div>
      </td>`;
    })
    .join("");

  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;border-collapse:collapse;">${cells}</table>`;
}

/** Key-value rows with optional value color */
export function emailKeyValueTable(
  rows: Array<{ label: string; value: string; valueColor?: string; mono?: boolean }>
): string {
  const tr = rows
    .map(
      (r) => `<tr>
        <td style="padding:10px 0;color:${BRAND_MUTED};width:38%;vertical-align:top;font-size:14px;">${escapeHtml(r.label)}</td>
        <td style="padding:10px 0;font-weight:600;color:${r.valueColor ?? BRAND_TEXT};font-size:14px;${r.mono ? "font-family:ui-monospace,monospace;font-size:12px;font-weight:500;" : ""}">${escapeHtml(r.value)}</td>
      </tr>`
    )
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border-top:1px solid ${BRAND_BORDER};">${tr}</table>`;
}

/** Highlight box for warnings, tips, or security notes */
export function emailCallout(text: string, tone: EmailTone = "info"): string {
  const s = TONE_STYLES[tone];
  return `<div style="margin:16px 0 0;padding:14px 16px;border-radius:12px;background:${s.bg};border:1px solid ${s.border};color:${s.text};font-size:14px;line-height:1.55;">${text}</div>`;
}

/** Horizontal fleet health bar (weekly digest) */
export function emailHealthBar(input: {
  healthy: number;
  warning: number;
  critical: number;
  total: number;
}): string {
  const { healthy, warning, critical, total } = input;
  if (total === 0) {
    return emailCallout(
      "No workflows registered yet. Add a database and run your first restore drill.",
      "info"
    );
  }
  const hPct = Math.round((healthy / total) * 100);
  const wPct = Math.round((warning / total) * 100);
  const cPct = Math.max(0, 100 - hPct - wPct);

  return `<div style="margin:0 0 20px;">
    <div style="display:block;height:10px;border-radius:999px;overflow:hidden;background:#e2e8f0;">
      <span style="display:inline-block;height:10px;width:${hPct}%;background:#10b981;vertical-align:top;"></span>
      <span style="display:inline-block;height:10px;width:${wPct}%;background:#f59e0b;vertical-align:top;"></span>
      <span style="display:inline-block;height:10px;width:${cPct}%;background:#ef4444;vertical-align:top;"></span>
    </div>
    <p style="margin:10px 0 0;font-size:13px;color:${BRAND_MUTED};">
      <span style="color:#059669;font-weight:600;">${healthy} healthy</span>
      · <span style="color:#d97706;font-weight:600;">${warning} need attention</span>
      · <span style="color:#dc2626;font-weight:600;">${critical} at risk</span>
      · ${total} total
    </p>
  </div>`;
}

export function formatEmailDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-IN", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "UTC",
    }) + " UTC";
  } catch {
    return iso;
  }
}

/** Shared HTML shell for all Revenant transactional emails */
export function wrapEmailHtml(input: EmailLayoutInput): string {
  const { brand, eyebrow, title, bodyHtml, cta, secondaryCta, footerNote } = input;
  const homeUrl = brand.marketingUrl ?? brand.appUrl;

  const ctaBlock =
    cta || secondaryCta
      ? `<p style="margin:28px 0 0;">
          ${
            cta
              ? `<a href="${escapeHtml(cta.url)}" style="display:inline-block;background:${BRAND_GOLD};color:${BRAND_DARK};text-decoration:none;padding:13px 24px;border-radius:10px;font-weight:700;font-size:14px;margin-right:10px;">${escapeHtml(cta.label)}</a>`
              : ""
          }
          ${
            secondaryCta
              ? `<a href="${escapeHtml(secondaryCta.url)}" style="display:inline-block;color:${BRAND_MUTED};text-decoration:none;padding:13px 8px;font-size:14px;font-weight:600;">${escapeHtml(secondaryCta.label)} →</a>`
              : ""
          }
        </p>`
      : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="light" />
  <title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background:${BRAND_BG};font-family:'IBM Plex Sans',Inter,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${BRAND_TEXT};-webkit-font-smoothing:antialiased;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND_BG};padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:580px;background:#ffffff;border-radius:16px;border:1px solid ${BRAND_BORDER};overflow:hidden;box-shadow:0 4px 24px rgba(15,23,42,0.08);">
          <tr>
            <td style="background:linear-gradient(135deg,${BRAND_DARK} 0%,#1e293b 100%);padding:26px 28px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="width:48px;vertical-align:middle;padding-right:14px;">
                    <img src="${escapeHtml(brand.logoUrl)}" alt="Revenant" width="44" height="44" style="display:block;border-radius:11px;border:0;" />
                  </td>
                  <td style="vertical-align:middle;">
                    ${eyebrow ? `<div style="font-size:11px;letter-spacing:0.1em;text-transform:uppercase;color:rgba(255,255,255,0.6);margin-bottom:5px;">${escapeHtml(eyebrow)}</div>` : ""}
                    <div style="font-size:21px;font-weight:700;color:#ffffff;line-height:1.35;">${escapeHtml(title)}</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:28px;font-size:15px;line-height:1.65;color:#334155;">
              ${bodyHtml}
              ${ctaBlock}
            </td>
          </tr>
          <tr>
            <td style="padding:20px 28px 26px;background:#f8fafc;border-top:1px solid ${BRAND_BORDER};font-size:12px;line-height:1.65;color:${BRAND_MUTED};">
              <p style="margin:0 0 6px;font-weight:700;font-size:13px;color:#334155;">Revenant</p>
              <p style="margin:0;">${escapeHtml(footerNote ?? "Backups aren't the product. Recovery is.")}</p>
              <p style="margin:14px 0 0;">
                <a href="${escapeHtml(homeUrl)}" style="color:${BRAND_GOLD};text-decoration:none;font-weight:600;">Website</a>
                &nbsp;·&nbsp;
                <a href="${escapeHtml(brand.appUrl)}" style="color:${BRAND_GOLD};text-decoration:none;font-weight:600;">Dashboard</a>
              </p>
            </td>
          </tr>
        </table>
        <p style="margin:18px 0 0;font-size:11px;color:#94a3b8;text-align:center;max-width:480px;">
          You received this because your organization uses Revenant Cloud.
        </p>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
