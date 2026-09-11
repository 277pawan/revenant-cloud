import type { JobDetailResource, WebhookProvider } from "@revenant/shared";

export type DeliveryResult = {
  ok: boolean;
  httpStatus?: number;
  error?: string;
};

export type EndpointRow = {
  id: string;
  provider: string;
  config: string;
  url: string | null;
  secret: string;
  credentialCiphertext: string | null;
  credentialIv: string | null;
  credentialAuthTag: string | null;
};

export type DeliverContext = {
  endpoint: EndpointRow;
  job: JobDetailResource;
  event: string;
  provider: WebhookProvider;
  config: Record<string, unknown>;
};
