import type { FastifyInstance } from "fastify";
import type { PublicHandlers } from "../../controllers/public.controller.js";
import type { ContactHandlers } from "../../controllers/contact.controller.js";
import type { FundingHandlers } from "../../controllers/funding.controller.js";
import type { EngagementHandlers } from "../../controllers/engagement.controller.js";

export async function publicRoutes(
  app: FastifyInstance,
  handlers: PublicHandlers,
  contactHandlers: ContactHandlers,
  fundingHandlers: FundingHandlers,
  engagementHandlers: EngagementHandlers
) {
  app.get("/public/catalog", handlers.catalog);
  app.post("/public/contact", contactHandlers.submit);
  app.post("/public/funding/create-order", fundingHandlers.createOrder);
  app.post("/public/funding/verify-payment", fundingHandlers.verifyPayment);
  app.post("/public/engagement", engagementHandlers.track);
  app.get("/public/engagement/counters", engagementHandlers.publicCounters);
}
