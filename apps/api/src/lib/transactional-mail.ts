import nodemailer from "nodemailer";
import type { Env } from "../config/env.js";

export function isTransactionalMailConfigured(env: Env): boolean {
  return !!(env.SMTP_USER && env.SMTP_PASS);
}

export async function sendTransactionalMail(
  env: Env,
  options: {
    to: string | string[];
    subject: string;
    text: string;
    html: string;
    replyTo?: string;
  }
): Promise<void> {
  if (!isTransactionalMailConfigured(env)) {
    console.warn("[mail] SMTP not configured — skipping:", options.subject);
    return;
  }

  const transporter = nodemailer.createTransport({
    host: env.SMTP_HOST ?? "smtp.gmail.com",
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    auth: { user: env.SMTP_USER!, pass: env.SMTP_PASS! },
  });

  await transporter.sendMail({
    from: env.SMTP_FROM ?? env.SMTP_USER,
    to: Array.isArray(options.to) ? options.to.join(", ") : options.to,
    replyTo: options.replyTo,
    subject: options.subject,
    text: options.text,
    html: options.html,
  });
}
