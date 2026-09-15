import { randomBytes } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import type {
  JobDetailResource,
  WebhookConfig,
  WebhookEndpointResource,
  WebhookProvider,
} from "@revenant/shared";
import type { Database } from "../db/index.js";
import { webhookDeliveries, webhookEndpoints } from "../db/schema.js";
import { deliverToProvider, INTEGRATION_PROVIDERS } from "../integrations/deliver.js";
import { encryptSecret } from "../lib/crypto.js";
import { createAppError } from "../lib/errors.js";
import type { Env } from "../config/env.js";
import { assertPlanLimit } from "../lib/plan-limits.js";
import type { CreateWebhookInput } from "../validations/webhooks.schema.js";
import {
  paginationMeta,
  paginationOffset,
  type PaginationQueryInput,
} from "../validations/pagination.schema.js";

function parseEvents(events: string): string[] {
  return events.split(",").map((e) => e.trim()).filter(Boolean);
}

function maskUrl(url: string): string {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/");
    const last = parts[parts.length - 1] ?? "";
    parts[parts.length - 1] = last.length > 4 ? `${last.slice(0, 4)}…` : "…";
    u.pathname = parts.join("/");
    return u.toString();
  } catch {
    return "••••";
  }
}

function publicConfig(
  provider: string,
  raw: string,
  hasCredential: boolean
): WebhookConfig {
  try {
    const config = JSON.parse(raw) as Record<string, unknown>;
    switch (provider) {
      case "slack":
        return {
          webhookUrl: maskUrl(String(config.webhookUrl ?? "")),
        } as WebhookConfig;
      case "email":
        return {
          smtpUser: String(config.smtpUser ?? ""),
          smtpFrom: String(config.smtpFrom ?? config.smtpUser ?? ""),
          smtpHost: String(config.smtpHost ?? "smtp.gmail.com"),
          smtpPort: Number(config.smtpPort ?? 587),
          recipients: Array.isArray(config.recipients)
            ? (config.recipients as string[])
            : [],
          hasSmtpPassword: hasCredential,
        };
      case "http":
        return { url: maskUrl(String(config.url ?? "")) };
      default:
        return config as unknown as WebhookConfig;
    }
  } catch {
    return {} as WebhookConfig;
  }
}

function toResource(row: typeof webhookEndpoints.$inferSelect): WebhookEndpointResource {
  const hasCredential = Boolean(
    row.credentialCiphertext && row.credentialIv && row.credentialAuthTag
  );
  return {
    id: row.id,
    name: row.name,
    provider: row.provider as WebhookProvider,
    config: publicConfig(row.provider, row.config, hasCredential),
    events: parseEvents(row.events),
    enabled: row.enabled === "true",
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function emailConfigForStorage(
  config: Extract<CreateWebhookInput, { provider: "email" }>["config"]
) {
  const smtpFrom = config.smtpFrom ?? config.smtpUser;
  return {
    smtpUser: config.smtpUser,
    smtpFrom,
    smtpHost: config.smtpHost ?? "smtp.gmail.com",
    smtpPort: config.smtpPort ?? 587,
    recipients: config.recipients,
  };
}

export function createWebhooksService(db: Database, masterKey: string, env: Env) {
  return {
    listProviders() {
      return { providers: INTEGRATION_PROVIDERS };
    },

    async list(organizationId: string, pagination: PaginationQueryInput) {
      const { page, pageSize } = pagination;
      const offset = paginationOffset(page, pageSize);

      const [rows, countRow] = await Promise.all([
        db
          .select()
          .from(webhookEndpoints)
          .where(eq(webhookEndpoints.organizationId, organizationId))
          .orderBy(desc(webhookEndpoints.updatedAt))
          .limit(pageSize)
          .offset(offset),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(webhookEndpoints)
          .where(eq(webhookEndpoints.organizationId, organizationId)),
      ]);

      const total = countRow[0]?.count ?? 0;
      return {
        data: rows.map(toResource),
        pagination: paginationMeta(total, page, pageSize),
      };
    },

    async create(organizationId: string, input: CreateWebhookInput) {
      await assertPlanLimit(db, organizationId, "integrations");
      const httpSecret =
        input.provider === "http" ? randomBytes(32).toString("hex") : "";

      let configJson: string;
      let credentialFields: {
        credentialCiphertext?: string;
        credentialIv?: string;
        credentialAuthTag?: string;
      } = {};

      if (input.provider === "email") {
        const encrypted = encryptSecret(input.config.smtpPassword, masterKey);
        credentialFields = {
          credentialCiphertext: encrypted.ciphertext,
          credentialIv: encrypted.iv,
          credentialAuthTag: encrypted.authTag,
        };
        configJson = JSON.stringify(emailConfigForStorage(input.config));
      } else {
        configJson = JSON.stringify(input.config);
      }

      const legacyUrl =
        input.provider === "http"
          ? (input.config as { url: string }).url
          : null;

      const [row] = await db
        .insert(webhookEndpoints)
        .values({
          organizationId,
          name: input.name,
          provider: input.provider,
          config: configJson,
          url: legacyUrl,
          secret: httpSecret || "n/a",
          events: input.events.join(","),
          enabled: input.enabled ? "true" : "false",
          ...credentialFields,
        })
        .returning();

      return {
        endpoint: toResource(row),
        secret: input.provider === "http" ? httpSecret : undefined,
      };
    },

    async update(
      organizationId: string,
      id: string,
      input: {
        name?: string;
        config?: Record<string, unknown>;
        events?: string[];
        enabled?: boolean;
      }
    ) {
      const existing = await db
        .select()
        .from(webhookEndpoints)
        .where(
          and(
            eq(webhookEndpoints.id, id),
            eq(webhookEndpoints.organizationId, organizationId)
          )
        )
        .limit(1);

      if (!existing[0]) {
        throw createAppError(404, "Webhook not found", "NOT_FOUND");
      }

      const patch: Partial<typeof webhookEndpoints.$inferInsert> = {
        updatedAt: new Date(),
      };
      if (input.name !== undefined) patch.name = input.name;
      if (input.events !== undefined) patch.events = input.events.join(",");
      if (input.enabled !== undefined)
        patch.enabled = input.enabled ? "true" : "false";

      if (input.config !== undefined) {
        const { smtpPassword, ...rest } = input.config;
        const current = JSON.parse(existing[0].config) as Record<string, unknown>;
        const merged = { ...current, ...rest };

        if (existing[0].provider === "email") {
          if (!merged.smtpFrom && merged.smtpUser) {
            merged.smtpFrom = merged.smtpUser;
          }
          if (smtpPassword && typeof smtpPassword === "string") {
            const encrypted = encryptSecret(smtpPassword, masterKey);
            patch.credentialCiphertext = encrypted.ciphertext;
            patch.credentialIv = encrypted.iv;
            patch.credentialAuthTag = encrypted.authTag;
          }
        }

        patch.config = JSON.stringify(merged);

        if (existing[0].provider === "http" && "url" in merged) {
          patch.url = String(merged.url);
        }
      }

      const [row] = await db
        .update(webhookEndpoints)
        .set(patch)
        .where(eq(webhookEndpoints.id, id))
        .returning();

      return toResource(row);
    },

    async remove(organizationId: string, id: string) {
      const [row] = await db
        .delete(webhookEndpoints)
        .where(
          and(
            eq(webhookEndpoints.id, id),
            eq(webhookEndpoints.organizationId, organizationId)
          )
        )
        .returning({ id: webhookEndpoints.id });

      if (!row) {
        throw createAppError(404, "Webhook not found", "NOT_FOUND");
      }
    },

    async dispatchForJob(organizationId: string, job: JobDetailResource) {
      const event = `job.${job.status}`;
      if (!["job.pass", "job.fail", "job.error"].includes(event)) return;

      const endpoints = await db
        .select()
        .from(webhookEndpoints)
        .where(
          and(
            eq(webhookEndpoints.organizationId, organizationId),
            eq(webhookEndpoints.enabled, "true")
          )
        );

      for (const endpoint of endpoints) {
        const subscribed = parseEvents(endpoint.events);
        if (!subscribed.includes(event)) continue;

        let ok = false;
        let httpStatus: number | undefined;
        let errorMessage: string | undefined;
        let attempts = 0;

        for (let i = 0; i < 3 && !ok; i++) {
          attempts++;
          const result = await deliverToProvider(endpoint, job, event, masterKey, {
            appUrl: env.PUBLIC_APP_URL,
          });
          ok = result.ok;
          httpStatus = result.httpStatus;
          errorMessage = result.error;
          if (!ok && i < 2) {
            await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
          }
        }

        await db.insert(webhookDeliveries).values({
          organizationId,
          endpointId: endpoint.id,
          jobId: job.id,
          event,
          status: ok ? "delivered" : "failed",
          httpStatus: httpStatus ?? null,
          errorMessage: errorMessage ?? null,
          attempts,
        });
      }
    },
  };
}

export type WebhooksService = ReturnType<typeof createWebhooksService>;
