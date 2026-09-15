import { dump } from "js-yaml";
import type { SchemaAnalysis, SchemaTable } from "./schema-analyzer.js";

type YamlCheck = Record<string, unknown>;

const DEFAULT_LAYERS = ["schema", "foreign_key", "row_count"];
const NOISE_TABLES = new Set([
  "schema_migrations",
  "drizzle_migrations",
  "_prisma_migrations",
  "sessions",
  "cache",
]);

/** Often empty after restore — do not require min:1 unless the user named them. */
const SPARSE_TABLES = new Set([
  "audit_events",
  "webhook_deliveries",
  "password_reset_tokens",
  "weekly_digest_log",
  "organization_invites",
  "user_auth_providers",
  "job_results",
  "evidence_artifacts",
  "database_aws_credentials",
]);

const CORE_HINTS = [
  "organizations",
  "users",
  "accounts",
  "databases",
  "orders",
  "customers",
  "validation_plans",
];

function checkKey(check: YamlCheck): string {
  return JSON.stringify(check);
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}

function tableNames(tables: SchemaTable[]): Set<string> {
  return new Set(tables.map((t) => t.name));
}

function existing(tables: SchemaTable[], names: string[]): string[] {
  const have = tableNames(tables);
  return unique(names.filter((name) => have.has(name)));
}

function dedupeChecks(checks: YamlCheck[]): YamlCheck[] {
  const seen = new Set<string>();
  const out: YamlCheck[] = [];
  for (const check of checks) {
    const key = checkKey(check);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(check);
  }
  return out;
}

function wantsAccountTable(intent: string): boolean {
  return /\baccount(s)?\b/.test(intent.toLowerCase());
}

/** Map "account table" to a real table — never invent `accounts`. */
export function resolveAccountTables(
  tables: SchemaTable[],
  intent: string
): SchemaTable[] {
  if (!wantsAccountTable(intent)) return [];

  const exact = tables.filter((t) => t.name === "accounts" || t.name === "account");
  if (exact.length > 0) return exact;

  const users = tables.filter((t) => t.name === "users" || t.name === "user");
  if (users.length > 0) return users;

  return tables.filter(
    (t) => t.name === "organizations" || t.name === "organization"
  );
}

function tablesMentionedInIntent(tables: SchemaTable[], intent: string): string[] {
  const lower = intent.toLowerCase();
  return tables
    .filter((t) => {
      if (NOISE_TABLES.has(t.name)) return false;
      return (
        lower.includes(t.name) || lower.includes(t.name.replace(/_/g, " "))
      );
    })
    .map((t) => t.name);
}

function pickSchemaTables(tables: SchemaTable[], intent: string, limit = 25): string[] {
  const mentioned = tablesMentionedInIntent(tables, intent);
  const accountTables = resolveAccountTables(tables, intent).map((t) => t.name);
  const core = tables.filter((t) => !NOISE_TABLES.has(t.name)).map((t) => t.name);

  return unique([
    ...mentioned,
    ...accountTables,
    ...existing(tables, CORE_HINTS),
    ...core,
  ]).slice(0, limit);
}

function pickRowCountTables(tables: SchemaTable[], intent: string, limit = 6): string[] {
  const accountTables = resolveAccountTables(tables, intent).map((t) => t.name);
  const mentioned = tablesMentionedInIntent(tables, intent);
  const names = existing(tables, [
    ...accountTables,
    ...mentioned,
    ...CORE_HINTS,
  ]).filter((name) => !SPARSE_TABLES.has(name) || mentioned.includes(name));

  if (names.length < limit) {
    for (const table of tables) {
      if (NOISE_TABLES.has(table.name) || SPARSE_TABLES.has(table.name)) continue;
      if (!names.includes(table.name)) names.push(table.name);
      if (names.length >= limit) break;
    }
  }
  return names.slice(0, limit);
}

function wantsTimestampChecks(intent: string, layers: string[]): boolean {
  const lower = intent.toLowerCase();
  const intentWants =
    /\bcreated(_at)?\b/.test(lower) ||
    /\bupdated(_at)?\b/.test(lower) ||
    /\btimestamp/.test(lower);
  return layers.includes("freshness") || intentWants;
}

function freshnessColumns(intent: string, layers: string[]): string[] {
  const lower = intent.toLowerCase();
  const wantsCreated = /\bcreated(_at)?\b/.test(lower);
  const wantsUpdated = /\bupdated(_at)?\b/.test(lower);
  const columns: string[] = [];
  if (wantsCreated) columns.push("created_at");
  if (wantsUpdated) columns.push("updated_at");
  if (columns.length === 0 && layers.includes("freshness")) {
    columns.push("updated_at");
  }
  return unique(columns);
}

function buildFreshnessChecks(
  tables: SchemaTable[],
  intent: string,
  layers: string[]
): YamlCheck[] {
  if (!wantsTimestampChecks(intent, layers)) return [];

  const columns = freshnessColumns(intent, layers);
  if (columns.length === 0) return [];

  const preferred = unique([
    ...resolveAccountTables(tables, intent).map((t) => t.name),
    ...tablesMentionedInIntent(tables, intent),
    ...existing(tables, ["users", "organizations", "databases", "accounts"]),
  ]);

  let targetTables = tables.filter((t) => preferred.includes(t.name));
  if (targetTables.length === 0) {
    targetTables = tables
      .filter((t) => columns.some((c) => t.columns.includes(c)))
      .slice(0, 3);
  }

  const checks: YamlCheck[] = [];
  for (const table of targetTables) {
    for (const column of columns) {
      if (!table.columns.includes(column)) continue;
      checks.push({
        type: "freshness",
        table: table.name,
        column,
        max_age: "7d",
      });
    }
  }
  return checks.slice(0, 8);
}

function buildGoldenQueryChecks(
  tables: SchemaTable[],
  intent: string,
  layers: string[]
): YamlCheck[] {
  const hasIntent = Boolean(intent.trim());
  if (!layers.includes("golden_query") && !hasIntent) return [];

  const checks: YamlCheck[] = [];
  const accountTables = resolveAccountTables(tables, intent);
  const lower = intent.toLowerCase();
  const wantsCreated = /\bcreated(_at)?\b/.test(lower);
  const wantsUpdated = /\bupdated(_at)?\b/.test(lower);

  for (const table of accountTables) {
    checks.push({
      type: "golden_query",
      query: `SELECT count(*) FROM ${table.name}`,
      expect_min: 1,
    });

    const hasCreated = table.columns.includes("created_at");
    const hasUpdated = table.columns.includes("updated_at");
    if (wantsCreated && wantsUpdated && hasCreated && hasUpdated) {
      checks.push({
        type: "golden_query",
        query: `SELECT count(*) FROM ${table.name} WHERE created_at IS NOT NULL AND updated_at IS NOT NULL`,
        expect_min: 1,
      });
    } else if (wantsCreated && hasCreated) {
      checks.push({
        type: "golden_query",
        query: `SELECT count(*) FROM ${table.name} WHERE created_at IS NOT NULL`,
        expect_min: 1,
      });
    } else if (wantsUpdated && hasUpdated) {
      checks.push({
        type: "golden_query",
        query: `SELECT count(*) FROM ${table.name} WHERE updated_at IS NOT NULL`,
        expect_min: 1,
      });
    }
  }

  if (checks.length === 0 && layers.includes("golden_query")) {
    const core = pickRowCountTables(tables, intent, 2);
    for (const name of core) {
      checks.push({
        type: "golden_query",
        query: `SELECT count(*) FROM ${name}`,
        expect_min: 1,
      });
    }
  }

  return checks.slice(0, 6);
}

function buildForeignKeyChecks(tables: SchemaTable[], limit = 8): YamlCheck[] {
  const preferredParents = new Set(
    existing(tables, ["organizations", "users", "databases", "jobs", "accounts"])
  );
  const ranked: YamlCheck[] = [];
  const rest: YamlCheck[] = [];

  for (const table of tables) {
    if (NOISE_TABLES.has(table.name) || SPARSE_TABLES.has(table.name)) continue;
    for (const fk of table.foreignKeys) {
      const check = {
        type: "foreign_key",
        table: table.name,
        references: fk.referencesTable,
      };
      if (preferredParents.has(fk.referencesTable)) ranked.push(check);
      else rest.push(check);
    }
  }
  return dedupeChecks([...ranked, ...rest]).slice(0, limit);
}

function buildIndexCheck(tables: SchemaTable[]): YamlCheck[] {
  const named = unique(
    tables.flatMap((t) => t.indexes.filter((idx) => !idx.endsWith("_pkey")))
  );
  const pkeys = unique(
    existing(tables, CORE_HINTS).map((name) => `${name}_pkey`)
  ).filter((idx) => tables.some((t) => t.indexes.includes(idx)));

  const indexes = unique([...named, ...pkeys]).slice(0, 20);
  if (indexes.length === 0) return [];
  return [{ type: "index", expect_indexes: indexes }];
}

export function buildChecksFromSchema(
  analysis: SchemaAnalysis,
  options: {
    planName: string;
    layers?: string[];
    intent?: string;
  }
): YamlCheck[] {
  const layers =
    options.layers && options.layers.length > 0
      ? options.layers
      : DEFAULT_LAYERS;
  const intent = options.intent?.trim() ?? "";
  const tables = analysis.tables.filter((t) => !NOISE_TABLES.has(t.name));

  const schemaChecks: YamlCheck[] = layers.includes("schema")
    ? [{ type: "schema", expect_tables: pickSchemaTables(tables, intent) }]
    : [];

  const freshnessChecks = buildFreshnessChecks(tables, intent, layers);
  const goldenChecks = buildGoldenQueryChecks(tables, intent, layers);

  const rowCountChecks: YamlCheck[] = layers.includes("row_count")
    ? pickRowCountTables(tables, intent).map((name) => ({
        type: "row_count",
        table: name,
        min: 1,
      }))
    : [];

  const foreignKeyChecks = layers.includes("foreign_key")
    ? buildForeignKeyChecks(tables)
    : [];

  const indexChecks = layers.includes("index") ? buildIndexCheck(tables) : [];

  return dedupeChecks([
    { type: "connect" },
    ...schemaChecks,
    ...freshnessChecks,
    ...goldenChecks,
    ...rowCountChecks,
    ...foreignKeyChecks,
    ...indexChecks,
  ]).slice(0, 40);
}

export function buildYamlFromChecks(
  planName: string,
  checks: YamlCheck[]
): string {
  const doc = {
    plan: planName,
    database: {
      engine: "postgres",
      connection: "${DATABASE_URL}",
    },
    checks,
  };
  return `${dump(doc, { lineWidth: 100, noRefs: true }).trim()}\n`;
}

export function composeYamlFromSchema(
  analysis: SchemaAnalysis,
  options: {
    planName: string;
    layers?: string[];
    intent?: string;
  }
): { yamlText: string; checks: Array<{ type: string }> } {
  const checks = buildChecksFromSchema(analysis, options);
  const yamlText = buildYamlFromChecks(
    options.planName.trim() || "restore-proof",
    checks
  );
  return {
    yamlText,
    checks: checks.map((c) => ({ type: String(c.type) })),
  };
}
