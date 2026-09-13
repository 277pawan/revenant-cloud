import { load as yamlLoad } from "js-yaml";

const ALLOWED = new Set([
  "connect",
  "schema",
  "row_count",
  "foreign_key",
  "golden_query",
  "freshness",
  "index",
]);

export interface ComposerCheck {
  type: string;
}

export function extractYamlDocument(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:yaml|yml)?\s*([\s\S]*?)```/i);
  return (fenced?.[1] ?? trimmed).trim();
}

export function validateRevenantYaml(text: string): {
  yamlText: string;
  checks: ComposerCheck[];
} {
  let doc: unknown;
  try {
    doc = yamlLoad(text);
  } catch (err) {
    throw new Error(
      err instanceof Error ? `Invalid YAML: ${err.message}` : "Invalid YAML"
    );
  }

  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error("YAML must be a mapping with plan, database, and checks");
  }

  const root = doc as Record<string, unknown>;
  if (typeof root.plan !== "string" || !root.plan.trim()) {
    throw new Error("plan: is required");
  }

  const database = root.database as Record<string, unknown> | undefined;
  if (!database || database.engine !== "postgres") {
    throw new Error("database.engine must be postgres");
  }
  if (typeof database.connection !== "string" || !database.connection.includes("${")) {
    throw new Error("database.connection must use ${DATABASE_URL} or ${SANDBOX_*}");
  }

  if (!Array.isArray(root.checks) || root.checks.length === 0) {
    throw new Error("checks: must be a non-empty list");
  }
  if (root.checks.length > 40) {
    throw new Error("Too many checks — keep the proof plan under 40");
  }

  const checks: ComposerCheck[] = [];
  root.checks.forEach((item, i) => {
    if (!item || typeof item !== "object") {
      throw new Error(`checks[${i}] must be a mapping`);
    }
    const c = item as Record<string, unknown>;
    const type = typeof c.type === "string" ? c.type.trim() : "";
    if (!ALLOWED.has(type)) {
      throw new Error(
        `checks[${i}]: unsupported type ${JSON.stringify(type)} (allowed: ${[...ALLOWED].join(", ")})`
      );
    }
    if (type === "schema" && !Array.isArray(c.expect_tables)) {
      throw new Error(`checks[${i}] schema: expect_tables is required`);
    }
    if (type === "row_count" && (typeof c.table !== "string" || c.min == null)) {
      throw new Error(`checks[${i}] row_count: table and min are required`);
    }
    if (
      type === "foreign_key" &&
      (typeof c.table !== "string" || typeof c.references !== "string")
    ) {
      throw new Error(`checks[${i}] foreign_key: table and references are required`);
    }
    if (type === "golden_query") {
      const q = typeof c.query === "string" ? c.query : "";
      if (!q.trim() || c.expect_min == null) {
        throw new Error(`checks[${i}] golden_query: query and expect_min are required`);
      }
      if (/\b(insert|update|delete|drop|alter|truncate)\b/i.test(q)) {
        throw new Error(`checks[${i}] golden_query: write/DDL SQL is not allowed`);
      }
    }
    if (
      type === "freshness" &&
      (typeof c.table !== "string" || typeof c.column !== "string" || typeof c.max_age !== "string")
    ) {
      throw new Error(`checks[${i}] freshness: table, column, and max_age are required`);
    }
    if (type === "index" && !Array.isArray(c.expect_indexes)) {
      throw new Error(`checks[${i}] index: expect_indexes is required`);
    }
    checks.push({ type });
  });

  return { yamlText: text.trim() + "\n", checks };
}

export function redactSchemaSecrets(schema: string): string {
  return schema
    .replace(/(password\s*=\s*)([^\s'"]+)/gi, "$1***")
    .replace(/(pwd\s*=\s*)([^\s'"]+)/gi, "$1***")
    .replace(/postgres:\/\/[^@\s]+@/gi, "postgres://***@");
}
