import { config } from "dotenv";
import { existsSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

/**
 * Load .env from repo root and optional apps/api override.
 *
 * npm runs API scripts with cwd = apps/api. Plain dotenv only checks cwd.
 * File lives at revenant-cloud/.env (four levels above src/config).
 */
export function loadDotenv(): void {
  const candidates: string[] = [];

  // From package dir when cwd is apps/api
  candidates.push(resolve(process.cwd(), ".env"));
  candidates.push(resolve(process.cwd(), "../../.env"));

  // From this file: apps/api/src/config/load-dotenv.ts
  const here = dirname(fileURLToPath(import.meta.url));
  candidates.push(resolve(here, "../../../../.env")); // revenant-cloud/.env
  candidates.push(resolve(here, "../../.env")); // apps/api/.env

  const seen = new Set<string>();
  for (const path of candidates) {
    if (seen.has(path) || !existsSync(path)) continue;
    seen.add(path);
    config({ path, override: true });
  }
}
