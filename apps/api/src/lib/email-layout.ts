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

export function emailBrandFromUrls(appUrl: string, marketingUrl?: string, logoUrl?: string): EmailBrand {
  const app = appUrl.replace(/\/$/, "");
  const marketing = marketingUrl?.replace(/\/$/, "");
  return {
    logoUrl: logoUrl?.trim() || (marketing ? `${marketing}/revenant_logo.png` : `${app}/revenant_logo.png`),
    appUrl: app,
    marketingUrl: marketing,
  };
}

export function resolveEmailBrand(env: Pick<Env, "PUBLIC_APP_URL" | "PUBLIC_MARKETING_URL" | "PUBLIC_EMAIL_LOGO_URL">): EmailBrand {
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
  footerNote?: string;
};

/** Shared HTML shell for all Revenant transactional emails */
export function wrapEmailHtml(input: EmailLayoutInput): string {
  const { brand, eyebrow, title, bodyHtml, cta, footerNote } = input;
  const homeUrl = brand.marketingUrl ?? brand.appUrl;

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
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;border:1px solid ${BRAND_BORDER};overflow:hidden;box-shadow:0 1px 3px rgba(15,23,42,0.06);">
          <tr>
            <td style="background:${BRAND_DARK};padding:24px 28px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="width:44px;vertical-align:middle;padding-right:12px;">
                    <img src="${escapeHtml(brand.logoUrl)}" alt="Revenant" width="40" height="40" style="display:block;border-radius:10px;border:0;" />
                  </td>
                  <td style="vertical-align:middle;">
                    ${eyebrow ? `<div style="font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.65);margin-bottom:4px;">${escapeHtml(eyebrow)}</div>` : ""}
                    <div style="font-size:20px;font-weight:700;color:#ffffff;line-height:1.3;">${escapeHtml(title)}</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:28px;font-size:15px;line-height:1.65;color:#334155;">
              ${bodyHtml}
              ${
                cta
                  ? `<p style="margin:28px 0 0;">
                <a href="${escapeHtml(cta.url)}" style="display:inline-block;background:${BRAND_GOLD};color:${BRAND_DARK};text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:700;font-size:14px;">${escapeHtml(cta.label)}</a>
              </p>`
                  : ""
              }
            </td>
          </tr>
          <tr>
            <td style="padding:18px 28px 24px;background:#f8fafc;border-top:1px solid ${BRAND_BORDER};font-size:12px;line-height:1.6;color:${BRAND_MUTED};">
              <p style="margin:0 0 8px;font-weight:600;color:#475569;">Revenant</p>
              <p style="margin:0;">${escapeHtml(footerNote ?? "Backups aren't the product. Recovery is.")}</p>
              <p style="margin:12px 0 0;">
                <a href="${escapeHtml(homeUrl)}" style="color:${BRAND_GOLD};text-decoration:none;">Website</a>
                &nbsp;·&nbsp;
                <a href="${escapeHtml(brand.appUrl)}" style="color:${BRAND_GOLD};text-decoration:none;">Dashboard</a>
              </p>
            </td>
          </tr>
        </table>
        <p style="margin:16px 0 0;font-size:11px;color:#94a3b8;text-align:center;">
          You received this email from Revenant Cloud.
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
