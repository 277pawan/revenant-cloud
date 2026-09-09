/** Shared types between API and web. Keep stable — breaking changes hurt both apps. */

export type UserRole = "admin" | "executor" | "viewer";

export type OrganizationPlan = "starter" | "pro" | "enterprise";

/**
 * Permissions used by requirePermission / requireRoles.
 * Same website, different users in one org — enforced by role on JWT.
 */
export type Permission =
  | "databases:read"
  | "databases:write"
  | "credentials:write"
  | "plans:read"
  | "plans:write"
  | "jobs:read"
  | "jobs:run"
  | "team:manage"
  | "team:read";

export const ROLE_PERMISSIONS: Record<UserRole, readonly Permission[]> = {
  admin: [
    "databases:read",
    "databases:write",
    "credentials:write",
    "plans:read",
    "plans:write",
    "jobs:read",
    "jobs:run",
    "team:manage",
    "team:read",
  ],
  executor: [
    "databases:read",
    "plans:read",
    "plans:write",
    "jobs:read",
    "jobs:run",
    "team:read",
  ],
  viewer: ["databases:read", "plans:read", "jobs:read", "team:read"],
} as const;

export function roleHasPermission(role: UserRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}

/** Standard list pagination — every list GET must return this shape */
export interface PaginationMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface Paginated<T> {
  data: T[];
  pagination: PaginationMeta;
}

export interface PaginationQuery {
  page?: number;
  pageSize?: number;
}

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

export type DatabaseEngine = "postgres";
export type SslMode = "require" | "prefer" | "disable";

/** Public database shape — never includes password */
export interface DatabaseResource {
  id: string;
  name: string;
  engine: DatabaseEngine | string;
  host: string | null;
  port: number | null;
  databaseName: string | null;
  username: string | null;
  sslMode: SslMode | string | null;
  region: string | null;
  description: string | null;
  hasCredentials: boolean;
  hasValidationPlan: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateDatabaseRequest {
  name: string;
  engine?: DatabaseEngine;
  host?: string;
  port?: number;
  databaseName?: string;
  username?: string;
  password?: string;
  sslMode?: SslMode;
  region?: string;
  description?: string;
}

export interface UpdateDatabaseRequest {
  name?: string;
  engine?: DatabaseEngine;
  host?: string | null;
  port?: number | null;
  databaseName?: string | null;
  username?: string | null;
  password?: string;
  sslMode?: SslMode | null;
  region?: string | null;
  description?: string | null;
}

export interface DatabaseResponse {
  database: DatabaseResource;
}

export interface ValidationPlanResource {
  id: string;
  databaseId: string;
  databaseName: string;
  name: string;
  yamlText: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertValidationPlanRequest {
  name?: string;
  yamlText: string;
}

export interface ValidationPlanResponse {
  plan: ValidationPlanResource;
}

export interface TeamMemberResource {
  id: string;
  email: string;
  role: UserRole;
  createdAt: string;
  updatedAt: string;
}

export interface InviteTeamMemberRequest {
  email: string;
  password: string;
  role: Exclude<UserRole, "admin"> | "admin";
}

export interface UpdateTeamMemberRequest {
  role: UserRole;
}

export interface TeamMemberResponse {
  member: TeamMemberResource;
}

export type JobStatus =
  | "pending"
  | "running"
  | "pass"
  | "fail"
  | "error"
  | "cancelled";

export type JobTrigger = "manual" | "schedule";

export type JobCheckStatus = "pass" | "fail" | "skip";

export interface JobResource {
  id: string;
  databaseId: string;
  databaseName: string;
  status: JobStatus | string;
  trigger: JobTrigger | string;
  triggeredByUserId: string | null;
  errorMessage: string | null;
  rtoSeconds: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface JobResultResource {
  id: string;
  checkName: string;
  checkType: string;
  status: JobCheckStatus | string;
  message: string | null;
  durationMs: number | null;
  createdAt: string;
}

export interface JobDetailResource extends JobResource {
  results: JobResultResource[];
}

export interface CreateJobRequest {
  databaseId: string;
}

export interface JobResponse {
  job: JobResource;
}

export interface JobDetailResponse {
  job: JobDetailResource;
}

export interface CompleteJobRequest {
  status: "pass" | "fail" | "error";
  errorMessage?: string;
  rtoSeconds?: number;
  results: Array<{
    checkName: string;
    checkType: string;
    status: JobCheckStatus;
    message?: string;
    durationMs?: number;
  }>;
}
