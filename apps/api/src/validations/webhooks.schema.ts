import { z } from "zod";

const webhookEventSchema = z.enum(["job.pass", "job.fail", "job.error"]);

const slackConfigSchema = z.object({
  webhookUrl: z
    .string()
    .url()
    .refine((u) => u.includes("hooks.slack.com"), "Must be a Slack Incoming Webhook URL"),
});

const emailConfigSchema = z.object({
  smtpUser: z.string().email("Enter a valid Gmail or SMTP email"),
  smtpPassword: z.string().min(8, "App password is required").max(256),
  smtpFrom: z.string().email().optional(),
  smtpHost: z.string().min(1).default("smtp.gmail.com"),
  smtpPort: z.coerce.number().int().min(1).max(65535).default(587),
  recipients: z.array(z.string().email()).min(1).max(20),
});

const httpConfigSchema = z.object({
  url: z.string().url().max(2048),
});

export const createWebhookSchema = z.discriminatedUnion("provider", [
  z.object({
    name: z.string().min(1).max(255),
    provider: z.literal("slack"),
    config: slackConfigSchema,
    events: z.array(webhookEventSchema).min(1).default(["job.pass", "job.fail"]),
    enabled: z.boolean().default(true),
  }),
  z.object({
    name: z.string().min(1).max(255),
    provider: z.literal("email"),
    config: emailConfigSchema,
    events: z.array(webhookEventSchema).min(1).default(["job.pass", "job.fail"]),
    enabled: z.boolean().default(true),
  }),
  z.object({
    name: z.string().min(1).max(255),
    provider: z.literal("http"),
    config: httpConfigSchema,
    events: z.array(webhookEventSchema).min(1).default(["job.pass", "job.fail"]),
    enabled: z.boolean().default(true),
  }),
]);

const emailUpdateConfigSchema = z.object({
  smtpUser: z.string().email().optional(),
  smtpPassword: z.string().min(8).max(256).optional(),
  smtpFrom: z.string().email().optional(),
  smtpHost: z.string().min(1).optional(),
  smtpPort: z.coerce.number().int().min(1).max(65535).optional(),
  recipients: z.array(z.string().email()).min(1).max(20).optional(),
});

export const updateWebhookSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  config: z
    .union([slackConfigSchema.partial(), emailUpdateConfigSchema, httpConfigSchema.partial()])
    .optional(),
  events: z.array(webhookEventSchema).min(1).optional(),
  enabled: z.boolean().optional(),
});

export const webhookIdParamSchema = z.object({
  id: z.string().uuid(),
});

export type CreateWebhookInput = z.infer<typeof createWebhookSchema>;
