/**
 * Control-plane schema.
 * Customer DB passwords live ONLY in database_credentials (AES-256-GCM ciphertext).
 * Never store plaintext passwords.
 */
import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 255 }).notNull(),
  plan: varchar("plan", { length: 50 }).notNull().default("starter"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    email: varchar("email", { length: 255 }).notNull(),
    passwordHash: text("password_hash").notNull(),
    /** admin | executor | viewer — enforced by requireRoles middleware */
    role: varchar("role", { length: 50 }).notNull().default("admin"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("users_org_email_idx").on(table.organizationId, table.email)]
);

/** Connection metadata — no secrets */
export const databases = pgTable("databases", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 255 }).notNull(),
  engine: varchar("engine", { length: 50 }).notNull().default("postgres"),
  host: varchar("host", { length: 255 }),
  port: integer("port").default(5432),
  databaseName: varchar("database_name", { length: 255 }),
  username: varchar("username", { length: 255 }),
  sslMode: varchar("ssl_mode", { length: 50 }).default("require"),
  region: varchar("region", { length: 50 }),
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Encrypted secrets for a database (1:1).
 * ciphertext + iv + auth_tag = AES-256-GCM of the password (never plaintext).
 */
export const databaseCredentials = pgTable(
  "database_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    databaseId: uuid("database_id")
      .notNull()
      .references(() => databases.id, { onDelete: "cascade" }),
    ciphertext: text("ciphertext").notNull(),
    iv: text("iv").notNull(),
    authTag: text("auth_tag").notNull(),
    keyVersion: integer("key_version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("database_credentials_database_id_idx").on(table.databaseId),
  ]
);

/**
 * One validation plan (revenant.yaml text) per database.
 * Version increments on each update.
 */
export const validationPlans = pgTable(
  "validation_plans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    databaseId: uuid("database_id")
      .notNull()
      .references(() => databases.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 255 }).notNull().default("default"),
    yamlText: text("yaml_text").notNull(),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("validation_plans_database_id_idx").on(table.databaseId)]
);

/**
 * Restore validation jobs — Phase 2.
 * status: pending → running → pass | fail | error | cancelled
 * executionMode: stub (local fake) | agent (self-hosted) | ci (GitHub Actions etc.)
 */
export const jobs = pgTable("jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  databaseId: uuid("database_id")
    .notNull()
    .references(() => databases.id, { onDelete: "cascade" }),
  status: varchar("status", { length: 50 }).notNull().default("pending"),
  trigger: varchar("trigger", { length: 50 }).notNull().default("manual"),
  /** stub | agent | ci — set when a runner claims the job */
  executionMode: varchar("execution_mode", { length: 50 }),
  claimedByRunnerId: uuid("claimed_by_runner_id"),
  triggeredByUserId: uuid("triggered_by_user_id").references(() => users.id, {
    onDelete: "set null",
  }),
  errorMessage: text("error_message"),
  rtoSeconds: integer("rto_seconds"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Per-org runners (self-hosted agent or CI).
 * Token shown once at create; only sha256 hash stored.
 * Global RUNNER_TOKEN remains for local stub only.
 */
export const runners = pgTable("runners", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 255 }).notNull(),
  /** agent | ci */
  kind: varchar("kind", { length: 50 }).notNull().default("agent"),
  tokenHash: text("token_hash").notNull(),
  tokenPrefix: varchar("token_prefix", { length: 12 }).notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Per-check results for a job */
export const jobResults = pgTable("job_results", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  jobId: uuid("job_id")
    .notNull()
    .references(() => jobs.id, { onDelete: "cascade" }),
  checkName: varchar("check_name", { length: 255 }).notNull(),
  checkType: varchar("check_type", { length: 100 }).notNull(),
  status: varchar("status", { length: 50 }).notNull(),
  message: text("message"),
  durationMs: integer("duration_ms"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Organization = typeof organizations.$inferSelect;
export type User = typeof users.$inferSelect;
export type DatabaseRow = typeof databases.$inferSelect;
export type DatabaseCredential = typeof databaseCredentials.$inferSelect;
export type ValidationPlan = typeof validationPlans.$inferSelect;
export type Job = typeof jobs.$inferSelect;
export type JobResult = typeof jobResults.$inferSelect;
export type Runner = typeof runners.$inferSelect;
