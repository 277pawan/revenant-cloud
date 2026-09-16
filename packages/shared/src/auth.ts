export type OAuthProviderId = "google" | "github" | "microsoft";

export type AuthProviderStatus = "live" | "coming_soon" | "disabled";

export interface AuthProviderInfo {
  id: OAuthProviderId;
  label: string;
  status: AuthProviderStatus;
  /** Present when status is live — frontend redirects here */
  authorizePath?: string;
}

export interface AuthProvidersResponse {
  providers: AuthProviderInfo[];
  passwordLoginEnabled: boolean;
  openRegistration: boolean;
}

export interface InvitePreviewResponse {
  organizationName: string;
  role: string;
  email: string;
  expiresAt: string;
}
