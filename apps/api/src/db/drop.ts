/**
 * DEV ONLY — drops all public tables + drizzle migration history.
 * Does not drop the database itself (use scripts/create-db.sh for that).
 */
import pg from "pg";
import { loadEnv } from "../config/env.js";

const env = loadEnv();

if (env.NODE_ENV === "production") {
  console.error("Refusing to drop tables when NODE_ENV=production");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: env.DATABASE_URL });

const sql = `
DO $$ DECLARE
  r RECORD;
BEGIN
  FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public') LOOP
    EXECUTE 'DROP TABLE IF EXISTS public.' || quote_ident(r.tablename) || ' CASCADE';
  END LOOP;
END $$;

DROP SCHEMA IF EXISTS drizzle CASCADE;
`;

await pool.query(sql);
await pool.end();
console.log("Dropped all public tables + drizzle schema (migration history).");
console.log("Next: npm run db:migrate");
