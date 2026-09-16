import type { Database } from "../db/index.js";
import { contactSubmissions } from "../db/schema.js";
import type { Env } from "../config/env.js";
import type { ContactSubmitInput } from "../validations/contact.schema.js";
import {
  isTransactionalMailConfigured,
  sendTransactionalMail,
} from "../lib/transactional-mail.js";
import { createAppError } from "../lib/errors.js";

const NOTIFY_DEFAULT = "bpawan277@gmail.com";

function notifyEmail(env: Env): string {
  return env.CONTACT_NOTIFY_EMAIL ?? NOTIFY_DEFAULT;
}

function subjectFor(input: ContactSubmitInput): string {
  if (input.type === "coffee") {
    const amt = input.amountInr ? ` ₹${input.amountInr}` : "";
    return `[Revenant] Funding${amt} — ${input.name}`;
  }
  return `[Revenant] Talk to us — ${input.name}`;
}

function htmlBody(input: ContactSubmitInput): string {
  const label = input.type === "coffee" ? "Buy coffee / funding" : "Talk to us";
  const amount =
    input.type === "coffee" && input.amountInr
      ? `<p><strong>Amount:</strong> ₹${input.amountInr}</p>`
      : "";
  const msg = input.message?.trim()
    ? `<p><strong>Message:</strong></p><p style="white-space:pre-wrap">${escapeHtml(input.message)}</p>`
    : "<p><em>No message provided.</em></p>";
  return `
    <h2>${label}</h2>
    <p><strong>Name:</strong> ${escapeHtml(input.name)}</p>
    <p><strong>Email:</strong> <a href="mailto:${escapeHtml(input.email)}">${escapeHtml(input.email)}</a></p>
    ${amount}
    ${msg}
    <hr />
    <p style="color:#64748b;font-size:12px">Sent from revenant.dev marketing site</p>
  `;
}

function textBody(input: ContactSubmitInput): string {
  const label = input.type === "coffee" ? "Buy coffee / funding" : "Talk to us";
  const amount =
    input.type === "coffee" && input.amountInr
      ? `Amount: ₹${input.amountInr}\n`
      : "";
  return `${label}\n\nName: ${input.name}\nEmail: ${input.email}\n${amount}\n${input.message ?? "(no message)"}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function createContactService(db: Database, env: Env) {
  return {
    async submit(input: ContactSubmitInput): Promise<{ ok: true; id: string }> {
      const [row] = await db
        .insert(contactSubmissions)
        .values({
          type: input.type,
          name: input.name,
          email: input.email.toLowerCase(),
          message:
            input.type === "coffee" && input.amountInr
              ? `[₹${input.amountInr}] ${input.message?.trim() || "Funding pledge"}`.trim()
              : input.message?.trim() || null,
          source: "marketing",
        })
        .returning({ id: contactSubmissions.id });

      if (!row) {
        throw createAppError(500, "Could not save submission", "INTERNAL");
      }

      const to = notifyEmail(env);

      if (isTransactionalMailConfigured(env)) {
        await sendTransactionalMail(env, {
          to,
          replyTo: input.email,
          subject: subjectFor(input),
          text: textBody(input),
          html: htmlBody(input),
        });
      } else if (env.NODE_ENV === "development") {
        console.log(`[dev] Contact form (${input.type}) from ${input.email}:`, input.message);
        console.log(`[dev] Would notify: ${to}`);
      } else {
        console.warn(
          "[mail] SMTP not configured — contact saved but email not sent:",
          row.id
        );
      }

      return { ok: true, id: row.id };
    },
  };
}

export type ContactService = ReturnType<typeof createContactService>;
