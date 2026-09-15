import nodemailer from "nodemailer";
import type { DeliverContext, DeliveryResult } from "./types.js";
import { decryptSecret } from "../lib/crypto.js";
import {
  jobAlertHtml,
  jobAlertPlainText,
  jobAlertSubject,
} from "../lib/notification-templates.js";

export async function deliverEmail(
  ctx: DeliverContext,
  masterKey: string
): Promise<DeliveryResult> {
  const recipients = Array.isArray(ctx.config.recipients)
    ? (ctx.config.recipients as string[])
    : [];

  if (recipients.length === 0) {
    return { ok: false, error: "No email recipients configured" };
  }

  const smtpUser = String(ctx.config.smtpUser ?? "");
  const smtpFrom = String(ctx.config.smtpFrom ?? smtpUser);
  const smtpHost = String(ctx.config.smtpHost ?? "smtp.gmail.com");
  const smtpPort = Number(ctx.config.smtpPort ?? 587);

  if (!smtpUser) {
    return { ok: false, error: "SMTP user is not configured" };
  }

  if (
    !ctx.endpoint.credentialCiphertext ||
    !ctx.endpoint.credentialIv ||
    !ctx.endpoint.credentialAuthTag
  ) {
    return { ok: false, error: "SMTP password is not stored for this integration" };
  }

  let smtpPassword: string;
  try {
    smtpPassword = decryptSecret(
      {
        ciphertext: ctx.endpoint.credentialCiphertext,
        iv: ctx.endpoint.credentialIv,
        authTag: ctx.endpoint.credentialAuthTag,
      },
      masterKey
    );
  } catch {
    return { ok: false, error: "Failed to decrypt SMTP credentials" };
  }

  const transporter = nodemailer.createTransport({
    host: smtpHost,
    port: smtpPort,
    secure: smtpPort === 465,
    auth: { user: smtpUser, pass: smtpPassword },
  });

  const subject = jobAlertSubject(ctx.event, ctx.job.databaseName);
  const text = jobAlertPlainText({ event: ctx.event, job: ctx.job });
  const html = jobAlertHtml({
    event: ctx.event,
    job: ctx.job,
    appUrl: ctx.appUrl,
  });

  try {
    const info = await transporter.sendMail({
      from: smtpFrom,
      to: recipients.join(", "),
      subject,
      text,
      html,
    });
    return { ok: true, httpStatus: 200, error: info.messageId };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Email delivery failed",
    };
  }
}
