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
  jsonb,
} from "drizzle-orm/pg-core";

export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 255 }).notNull(),
  plan: varchar("plan", { length: 50 }).notNull().default("starter"),
  /** trialing | active | past_due | canceled — Razorpay webhook updates active */
  subscriptionStatus: varchar("subscription_status", { length: 50 })
    .notNull()
    .default("trialing"),
  trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }),
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
    /** Null for OAuth-only accounts */
    passwordHash: text("password_hash"),
    /** admin | executor | viewer — enforced by requireRoles middleware */
    role: varchar("role", { length: 50 }).notNull().default("admin"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("users_org_email_idx").on(table.organizationId, table.email)]
);

/** Linked OAuth / SSO identities (Google, GitHub) */
export const userAuthProviders = pgTable(
  "user_auth_providers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: varchar("provider", { length: 50 }).notNull(),
    providerSubject: varchar("provider_subject", { length: 255 }).notNull(),
    email: varchar("email", { length: 255 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("user_auth_providers_provider_subject_idx").on(
      table.provider,
      table.providerSubject
    ),
  ]
);

/** Email invite tokens — replaces admin-set passwords in Phase 2 */
export const organizationInvites = pgTable(
  "organization_invites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    email: varchar("email", { length: 255 }).notNull(),
    role: varchar("role", { length: 50 }).notNull().default("executor"),
    tokenHash: text("token_hash").notNull(),
    invitedBy: uuid("invited_by").references(() => users.id, { onDelete: "set null" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("organization_invites_org_email_idx").on(
      table.organizationId,
      table.email
    ),
  ]
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
  /** direct = connect to host; aws-rds = snapshot restore drill via CLI */
  recoveryMode: varchar("recovery_mode", { length: 50 }).notNull().default("direct"),
  /** RDS instance identifier for FindLatestSnapshot (aws-rds mode) */
  rdsSourceIdentifier: varchar("rds_source_identifier", { length: 255 }),
  recoveryUseFreetier: varchar("recovery_use_freetier", { length: 10 })
    .notNull()
    .default("false"),
  recoverySandboxInstanceClass: varchar("recovery_sandbox_instance_class", {
    length: 50,
  }),
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
/**
 * Encrypted AWS access key pair for aws-rds recovery (1:1 per database).
 * Plaintext JSON: { accessKeyId, secretAccessKey }
 */
export const databaseAwsCredentials = pgTable(
  "database_aws_credentials",
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
    uniqueIndex("database_aws_credentials_database_id_idx").on(table.databaseId),
  ]
);

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
 * One agent service per database / validation plan.
 * Token shown once when issued; only sha256 hash stored.
 */
export const runners = pgTable("runners", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  databaseId: uuid("database_id").references(() => databases.id, {
    onDelete: "cascade",
  }),
  name: varchar("name", { length: 255 }).notNull(),
  /** agent | ci */
  kind: varchar("kind", { length: 50 }).notNull().default("agent"),
  tokenHash: text("token_hash").notNull(),
  tokenPrefix: varchar("token_prefix", { length: 12 }).notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Cron schedules — Phase 4.
 * One schedule per database / validation workflow (optional).
 */
export const schedules = pgTable(
  "schedules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    databaseId: uuid("database_id")
      .notNull()
      .references(() => databases.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 255 }).notNull(),
    cronExpression: varchar("cron_expression", { length: 100 }).notNull(),
    timezone: varchar("timezone", { length: 64 }).notNull().default("UTC"),
    enabled: varchar("enabled", { length: 10 }).notNull().default("true"),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("schedules_database_id_idx").on(table.databaseId),
  ]
);

/** Signed job reports — Phase 4 evidence vault */
export const evidenceArtifacts = pgTable("evidence_artifacts", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  jobId: uuid("job_id")
    .notNull()
    .references(() => jobs.id, { onDelete: "cascade" }),
  kind: varchar("kind", { length: 50 }).notNull().default("json"),
  storageKey: text("storage_key").notNull(),
  sha256: varchar("sha256", { length: 64 }).notNull(),
  byteSize: integer("byte_size").notNull(),
  signedAt: timestamp("signed_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Outbound webhook endpoints per org */
export const webhookEndpoints = pgTable("webhook_endpoints", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 255 }).notNull(),
  /** slack | email | http */
  provider: varchar("provider", { length: 50 }).notNull().default("http"),
  /** Provider-specific JSON (webhook URLs, emails, routing keys) */
  config: text("config").notNull().default("{}"),
  /** Legacy / http provider — optional for app integrations */
  url: text("url"),
  secret: text("secret").notNull(),
  /** AES-256-GCM encrypted SMTP app password (email provider) */
  credentialCiphertext: text("credential_ciphertext"),
  credentialIv: text("credential_iv"),
  credentialAuthTag: text("credential_auth_tag"),
  events: text("events").notNull().default("job.pass,job.fail"),
  enabled: varchar("enabled", { length: 10 }).notNull().default("true"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Webhook delivery attempts */
export const webhookDeliveries = pgTable("webhook_deliveries", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  endpointId: uuid("endpoint_id")
    .notNull()
    .references(() => webhookEndpoints.id, { onDelete: "cascade" }),
  jobId: uuid("job_id")
    .notNull()
    .references(() => jobs.id, { onDelete: "cascade" }),
  event: varchar("event", { length: 50 }).notNull(),
  status: varchar("status", { length: 50 }).notNull().default("pending"),
  httpStatus: integer("http_status"),
  errorMessage: text("error_message"),
  attempts: integer("attempts").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Append-only audit trail */
export const auditEvents = pgTable("audit_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  actorUserId: uuid("actor_user_id").references(() => users.id, {
    onDelete: "set null",
  }),
  action: varchar("action", { length: 100 }).notNull(),
  resourceType: varchar("resource_type", { length: 100 }).notNull(),
  resourceId: varchar("resource_id", { length: 255 }).notNull(),
  metadata: text("metadata"),
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

export const passwordResetTokens = pgTable("password_reset_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const weeklyDigestLog = pgTable(
  "weekly_digest_log",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    weekKey: varchar("week_key", { length: 12 }).notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("weekly_digest_log_org_week_idx").on(
      table.organizationId,
      table.weekKey
    ),
  ]
);

/** Marketing site — Talk to us / Buy coffee forms */
export const contactSubmissions = pgTable("contact_submissions", {
  id: uuid("id").primaryKey().defaultRandom(),
  type: varchar("type", { length: 32 }).notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  email: varchar("email", { length: 255 }).notNull(),
  message: text("message"),
  source: varchar("source", { length: 64 }).notNull().default("marketing"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Aggregate counters per surface (marketing | app) */
export const siteTrafficCounters = pgTable("site_traffic_counters", {
  site: varchar("site", { length: 32 }).primaryKey(),
  totalVisits: integer("total_visits").notNull().default(0),
  totalHeroViews: integer("total_hero_views").notNull().default(0),
  totalLogins: integer("total_logins").notNull().default(0),
  totalRegisters: integer("total_registers").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Detailed engagement events (visits, hero, login, register, page_view) */
export const siteEngagementEvents = pgTable("site_engagement_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  site: varchar("site", { length: 32 }).notNull(),
  eventType: varchar("event_type", { length: 64 }).notNull(),
  path: text("path"),
  visitorId: varchar("visitor_id", { length: 64 }).notNull(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
  userEmail: varchar("user_email", { length: 255 }),
  visibility: varchar("visibility", { length: 32 }).notNull().default("visible"),
  meta: jsonb("meta"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Organization = typeof organizations.$inferSelect;
export type User = typeof users.$inferSelect;
export type DatabaseRow = typeof databases.$inferSelect;
export type DatabaseCredential = typeof databaseCredentials.$inferSelect;
export type DatabaseAwsCredential = typeof databaseAwsCredentials.$inferSelect;
export type ValidationPlan = typeof validationPlans.$inferSelect;
export type Job = typeof jobs.$inferSelect;
export type JobResult = typeof jobResults.$inferSelect;
export type Runner = typeof runners.$inferSelect;
export type Schedule = typeof schedules.$inferSelect;
export type EvidenceArtifact = typeof evidenceArtifacts.$inferSelect;
export type WebhookEndpoint = typeof webhookEndpoints.$inferSelect;
export type WebhookDelivery = typeof webhookDeliveries.$inferSelect;
export type AuditEvent = typeof auditEvents.$inferSelect;
