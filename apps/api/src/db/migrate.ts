import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { loadEnv } from "../config/env.js";

const env = loadEnv();

const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
const db = drizzle(pool);

await migrate(db, { migrationsFolder: "./drizzle" });
await pool.end();
console.log("Migrations applied.");
