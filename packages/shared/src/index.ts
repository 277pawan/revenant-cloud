/** Shared types between API and web. Keep stable — breaking changes hurt both apps. */

export type UserRole = "admin" | "executor" | "viewer";

export type OrganizationPlan = "starter" | "pro" | "enterprise";

export interface AuthUser {
  id: string;
  email: string;
  role: UserRole;
  organizationId: string;
  organizationName: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface LoginResponse {
  token: string;
  user: AuthUser;
}

export interface RegisterRequest {
  organizationName: string;
  email: string;
  password: string;
}

export interface ApiError {
  error: string;
  code?: string;
}

export interface HealthResponse {
  status: "ok";
  service: "revenant-api";
  version: string;
}
