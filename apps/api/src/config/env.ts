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
  CORS_ORIGIN: z.string().default("http://localhost:5173"),
  COOKIE_SECURE: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  ALLOW_OPEN_REGISTRATION: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  /** Shared secret for runner claim/complete endpoints */
  RUNNER_TOKEN: z.string().min(16, "RUNNER_TOKEN must be at least 16 characters"),
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
