import { PLAN_DEFINITIONS, type PublicCatalogResponse } from "@revenant/shared";
import type { AuthProvidersService } from "../services/auth-providers.service.js";
import type { Env } from "../config/env.js";
import { SESSION_COOKIE } from "../lib/session.js";

export function createPublicHandlers(
  env: Env,
  authProvidersService: AuthProvidersService
) {
  return {
    catalog: async (): Promise<PublicCatalogResponse> => {
      const auth = authProvidersService.listProviders();
      return {
        product: {
          name: "Revenant",
          tagline: "Prove restore actually works — before the outage.",
          appUrl: env.PUBLIC_APP_URL,
          appLoginUrl: `${env.PUBLIC_APP_URL.replace(/\/$/, "")}/login`,
          marketingUrl: env.PUBLIC_MARKETING_URL ?? null,
        },
        plans: Object.values(PLAN_DEFINITIONS),
        auth: {
          ...auth,
          oauthStartBasePath: "/api/v1/auth/oauth",
        },
        session: {
          cookieName: SESSION_COOKIE,
          cookieDomainHint: env.COOKIE_DOMAIN ?? null,
        },
      };
    },
  };
}

export type PublicHandlers = ReturnType<typeof createPublicHandlers>;
