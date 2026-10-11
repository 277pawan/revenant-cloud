import { load as yamlLoad } from "js-yaml";

const ALLOWED = new Set([
  "connect",
  "schema",
  "row_count",
  "foreign_key",
  "golden_query",
  "freshness",
  "index",
  "collections",
  "document_count",
  "document_schema",
  "mongo_freshness",
]);
const MONGODB_CHECKS = new Set([
  "connect",
  "collections",
  "document_count",
  "document_schema",
  "mongo_freshness",
  "index",
  "http_health",
]);
const SQL_CHECKS = new Set([
  "connect",
  "schema",
  "row_count",
  "foreign_key",
  "golden_query",
  "freshness",
  "index",
  "http_health",
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
  const engine = String(database?.engine ?? "");
  if (!database || !["postgres", "mysql", "mongodb"].includes(engine)) {
    throw new Error("database.engine must be postgres, mysql, or mongodb");
  }
  if (typeof database.connection !== "string" || !database.connection.includes("${")) {
    throw new Error("database.connection must use ${DATABASE_URL} or ${SANDBOX_*}");
  }
  if (
    engine === "mongodb" &&
    (typeof database.name !== "string" || !database.name.trim())
  ) {
    throw new Error("MongoDB database.name is required");
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
    const allowed = engine === "mongodb" ? MONGODB_CHECKS : SQL_CHECKS;
    if (!ALLOWED.has(type) || !allowed.has(type)) {
      throw new Error(
        `checks[${i}]: unsupported type ${JSON.stringify(type)} for ${engine} (allowed: ${[...allowed].join(", ")})`
      );
    }
    if (type === "schema" && !Array.isArray(c.expect_tables)) {
      throw new Error(`checks[${i}] schema: expect_tables is required`);
    }
    if (type === "collections" && engine !== "mongodb") {
      throw new Error(`checks[${i}] collections is only supported for MongoDB`);
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
    if (type === "collections" && (!Array.isArray(c.expect_collections) || c.expect_collections.length === 0)) {
      throw new Error(`checks[${i}] collections: expect_collections is required`);
    }
    if (
      type === "document_count" &&
      (typeof c.collection !== "string" ||
        !c.collection.trim() ||
        typeof c.min !== "number" ||
        !Number.isInteger(c.min) ||
        c.min < 0)
    ) {
      throw new Error(`checks[${i}] document_count: collection and a non-negative integer min are required`);
    }
    if (
      type === "document_count" &&
      c.max != null &&
      (typeof c.max !== "number" ||
        !Number.isInteger(c.max) ||
        c.max < 0)
    ) {
      throw new Error(`checks[${i}] document_count: max must be a non-negative integer`);
    }
    if (
      type === "document_count" &&
      typeof c.min === "number" &&
      typeof c.max === "number" &&
      c.max < c.min
    ) {
      throw new Error(`checks[${i}] document_count: max must be >= min`);
    }
    if (type === "document_count" && c.filter != null) {
      if (!isPlainRecord(c.filter)) {
        throw new Error(`checks[${i}] document_count: filter must be a MongoDB query mapping`);
      }
      assertSafeMongoFilter(c.filter, i);
    }
    if (
      type === "document_schema" &&
      (typeof c.collection !== "string" ||
        !c.collection.trim() ||
        (!c.expect_fields && !c.required_fields))
    ) {
      throw new Error(`checks[${i}] document_schema: collection and expect_fields or required_fields are required`);
    }
    if (
      type === "document_schema" &&
      c.expect_fields != null &&
      (!isPlainRecord(c.expect_fields) ||
        Object.keys(c.expect_fields).length === 0 ||
        Object.values(c.expect_fields).some((value) => typeof value !== "string"))
    ) {
      throw new Error(`checks[${i}] document_schema: expect_fields must map field names to BSON type strings`);
    }
    if (
      type === "document_schema" &&
      c.required_fields != null &&
      (!Array.isArray(c.required_fields) ||
        c.required_fields.length === 0 ||
        c.required_fields.some((field) => typeof field !== "string" || !field.trim()))
    ) {
      throw new Error(`checks[${i}] document_schema: required_fields must be a non-empty list of field names`);
    }
    if (type === "mongo_freshness" && (typeof c.collection !== "string" || !c.collection.trim() || typeof c.field !== "string" || !c.field.trim() || typeof c.max_age !== "string")) {
      throw new Error(`checks[${i}] mongo_freshness: collection, field, and max_age are required`);
    }
    if (type === "mongo_freshness" && !/^\d+(\.\d+)?(ms|s|m|h)$/.test(String(c.max_age))) {
      throw new Error(`checks[${i}] mongo_freshness: max_age must be a duration like 30m or 24h`);
    }
    if (engine === "mongodb" && type === "index" && (typeof c.collection !== "string" || !c.collection.trim())) {
      throw new Error(`checks[${i}] MongoDB index: collection is required`);
    }
    if (
      engine === "mongodb" &&
      type === "index" &&
      (!Array.isArray(c.expect_indexes) ||
        c.expect_indexes.length === 0 ||
        c.expect_indexes.some((name) => typeof name !== "string" || !name.trim()))
    ) {
      throw new Error(`checks[${i}] MongoDB index: expect_indexes must be a non-empty list`);
    }
    checks.push({ type });
  });

  return { yamlText: text.trim() + "\n", checks };
}

export function redactSchemaSecrets(schema: string): string {
  return schema
    .replace(/(password\s*=\s*)([^\s'"]+)/gi, "$1***")
    .replace(/(pwd\s*=\s*)([^\s'"]+)/gi, "$1***")
    .replace(/(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql):\/\/[^@\s]+@/gi, (uri) => `${uri.slice(0, uri.indexOf("://") + 3)}***@`)
    .replace(/(["']?(?:password|passwd|secret|access_token|api_key)["']?\s*:\s*)(["'][^"']*["']|[^,\s}\]]+)/gi, "$1\"***\"");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertSafeMongoFilter(filter: Record<string, unknown>, checkIndex: number): void {
  const blockedOperators = new Set(["$where", "$function", "$accumulator", "$out", "$merge"]);
  const allowedOperators = new Set([
    "$eq", "$gt", "$gte", "$lt", "$lte", "$in", "$nin", "$ne", "$exists",
    "$and", "$or", "$nor", "$regex", "$options", "$elemMatch", "$type",
    "$not", "$size", "$all", "$mod", "$bitsAllSet", "$bitsAnySet",
    "$bitsAllClear", "$bitsAnyClear",
  ]);
  for (const [key, value] of Object.entries(filter)) {
    if (blockedOperators.has(key)) {
      throw new Error(`checks[${checkIndex}] document_count: MongoDB operator ${key} is not allowed`);
    }
    if (key.startsWith("$") && !allowedOperators.has(key)) {
      throw new Error(`checks[${checkIndex}] document_count: unsupported MongoDB filter operator ${key}`);
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (isPlainRecord(entry)) assertSafeMongoFilter(entry, checkIndex);
      }
    } else if (isPlainRecord(value)) {
      assertSafeMongoFilter(value, checkIndex);
    }
  }
}
