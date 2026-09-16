import type { AuthProvidersResponse } from "./auth.js";
import type { PlanDefinition } from "./plans.js";

/** Unauthenticated payload for the future marketing site + app login. */
export interface PublicCatalogResponse {
  product: {
    name: string;
    tagline: string;
    appUrl: string;
    appLoginUrl: string;
    marketingUrl: string | null;
  };
  plans: PlanDefinition[];
  billing: {
    starterTrialDays: number;
    razorpayReady: boolean;
  };
  auth: AuthProvidersResponse & {
    oauthStartBasePath: string;
  };
  session: {
    cookieName: string;
    /** Set COOKIE_DOMAIN=.example.com when app + site share a parent domain */
    cookieDomainHint: string | null;
  };
}
