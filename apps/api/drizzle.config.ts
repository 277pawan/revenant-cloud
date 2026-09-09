import { config } from "dotenv";
import { existsSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { defineConfig } from "drizzle-kit";

const here = dirname(fileURLToPath(import.meta.url));
for (const path of [
  resolve(process.cwd(), ".env"),
  resolve(process.cwd(), "../../.env"),
  resolve(here, "../../../../.env"),
  resolve(here, "../../.env"),
]) {
  if (existsSync(path)) config({ path, override: true });
}

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
