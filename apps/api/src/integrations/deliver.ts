import type { JobDetailResource, WebhookProvider } from "@revenant/shared";
import { deliverEmail } from "./email.js";
import { deliverHttp } from "./http.js";
import { deliverSlack } from "./slack.js";
import type { DeliveryResult, EndpointRow } from "./types.js";

function parseConfig(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function deliverToProvider(
  endpoint: EndpointRow,
  job: JobDetailResource,
  event: string,
  masterKey: string
): Promise<DeliveryResult> {
  const provider = endpoint.provider as WebhookProvider;
  const config = parseConfig(endpoint.config);

  const ctx = { endpoint, job, event, provider, config };

  switch (provider) {
    case "slack":
      return deliverSlack(ctx);
    case "email":
      return deliverEmail(ctx, masterKey);
    case "http":
    default:
      return deliverHttp(ctx);
  }
}

export const INTEGRATION_PROVIDERS = [
  {
    id: "slack" as const,
    name: "Slack",
    description: "Post alerts to a Slack channel via Incoming Webhook.",
    setupHint:
      "In Slack: Apps → Incoming Webhooks → Add to Slack → copy the webhook URL.",
  },
  {
    id: "email" as const,
    name: "Email",
    description: "Send alerts from your Gmail via SMTP.",
    setupHint: "Your Gmail address, App Password, and who should receive alerts.",
  },
  {
    id: "http" as const,
    name: "Custom HTTP",
    description: "Advanced: POST signed JSON to any URL you control.",
    setupHint: "For custom APIs, Zapier, Make, or internal services.",
  },
];
