import { z } from "zod";
import { loadDotenv } from "./load-dotenv.js";

// Must run before reading process.env
loadDotenv();

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  API_PORT: z.coerce.number().default(8080),
  API_HOST: z.string().default("0.0.0.0"),
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  JWT_EXPIRES_IN: z.string().default("7d"),
  /** AES-256 key as base64 (32 bytes). Generate: openssl rand -base64 32 */
  MASTER_KEY: z
    .string()
    .min(1, "MASTER_KEY is required")
    .refine((v) => {
      try {
        return Buffer.from(v, "base64").length === 32;
      } catch {
        return false;
      }
    }, "MASTER_KEY must be base64 of exactly 32 bytes (openssl rand -base64 32)"),
  /** Comma-separated origins: app + future marketing site */
  CORS_ORIGIN: z.string().default("http://localhost:5173"),
  /** Public app origin (SSO return + catalog login URL) */
  PUBLIC_APP_URL: z.string().default("http://localhost:5173"),
  /** Optional marketing site origin — add the same value to CORS_ORIGIN */
  PUBLIC_MARKETING_URL: z.string().optional(),
  /** e.g. .revenant.cloud so website + app share the session cookie */
  COOKIE_DOMAIN: z.string().optional(),
  COOKIE_SECURE: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  ALLOW_OPEN_REGISTRATION: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  /** Shared secret for runner claim/complete endpoints (also used by embedded worker) */
  RUNNER_TOKEN: z.string().min(16, "RUNNER_TOKEN must be at least 16 characters"),
  /**
   * When true, API process polls/claims jobs itself (no separate runner:stub terminal).
   * Default: on in development, off in production.
   */
  EMBEDDED_RUNNER: z
    .enum(["true", "false", "auto"])
    .default("auto")
    .transform((v) => {
      if (v === "true") return true;
      if (v === "false") return false;
      return (process.env.NODE_ENV ?? "development") !== "production";
    }),
  /** Optional absolute path to revenant CLI binary */
  REVENANT_CLI_PATH: z.string().optional(),
  /** Directory for signed evidence JSON artifacts */
  EVIDENCE_DIR: z.string().default("./data/evidence"),
  /**
   * When true, API process polls due schedules and enqueues jobs.
   * Default: on in development, off in production.
   */
  EMBEDDED_SCHEDULER: z
    .enum(["true", "false", "auto"])
    .default("auto")
    .transform((v) => {
      if (v === "true") return true;
      if (v === "false") return false;
      return (process.env.NODE_ENV ?? "development") !== "production";
    }),
  /** Optional — required for Email integration alerts */
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().email().optional(),
  SMTP_SECURE: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  /** OAuth — optional until SSO goes live */
  OAUTH_GOOGLE_CLIENT_ID: z.string().optional(),
  OAUTH_GOOGLE_CLIENT_SECRET: z.string().optional(),
  OAUTH_GITHUB_CLIENT_ID: z.string().optional(),
  OAUTH_GITHUB_CLIENT_SECRET: z.string().optional(),
  /** Public API base for OAuth redirect URIs (defaults to localhost API) */
  OAUTH_REDIRECT_BASE_URL: z.string().default("http://localhost:8080"),
  /**
   * Proof Composer — Mistral or OpenRouter (sk-or-v1-…).
   * OpenRouter keys are auto-routed even if MISTRAL_API_URL points at api.mistral.ai.
   */
  MISTRAL_API_KEY: z.string().optional(),
  MISTRAL_API_URL: z.string().optional(),
  MISTRAL_MODEL: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error("Invalid environment:", parsed.error.flatten().fieldErrors);
    process.exit(1);
  }
  return parsed.data;
}
