import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { analyzeSchema } from "./schema-analyzer.js";
import {
  composeYamlFromSchema,
  resolveAccountTables,
} from "./composer-check-builder.js";
import { redactSchemaSecrets, validateRevenantYaml } from "./revenant-yaml.js";

const schemaPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../db/schema.ts"
);

describe("composeYamlFromSchema — control-plane drizzle + optional rules", () => {
  const schema = readFileSync(schemaPath, "utf8");
  const analysis = analyzeSchema(schema);
  const intent =
    "add some rules like created and updated at based + account table also add to check";
  const layers = [
    "schema",
    "foreign_key",
    "row_count",
    "freshness",
    "index",
    "golden_query",
  ];

  it("parses drizzle pgTable schema", () => {
    assert.ok(analysis);
    assert.equal(analysis.dialect, "drizzle");
    assert.ok(analysis.tables.length >= 15);
    assert.ok(analysis.tables.some((t) => t.name === "users"));
    assert.ok(!analysis.tables.some((t) => t.name === "accounts"));
  });

  describe("MongoDB Proof Composer YAML validation", () => {
    it("accepts MongoDB check types and keeps database name explicit", () => {
      const yaml = `  plan: atlas-users
  database:
    engine: mongodb
    connection: \${MONGODB_URI}
    name: \${MONGODB_DATABASE}
  checks:
    - type: connect
    - type: collections
      expect_collections: [users]
    - type: document_count
      collection: users
      min: 1
      filter:
        active: true
        age:
          $gte: 18
    - type: document_schema
      collection: users
      required_fields: [email]
      expect_fields:
        email: string
    - type: mongo_freshness
      collection: users
      field: updated_at
      max_age: 24h
    - type: index
      collection: users
      expect_indexes: [email_1]
  `;
      const parsed = validateRevenantYaml(yaml);
      assert.equal(parsed.checks.length, 6);
      assert.match(parsed.yamlText, /engine: mongodb/);
    });

    it("rejects SQL-only checks in MongoDB plans", () => {
      assert.throws(
        () =>
          validateRevenantYaml(`  plan: bad
  database:
    engine: mongodb
    connection: \${MONGODB_URI}
    name: app
  checks:
    - type: golden_query
      query: "SELECT 1"
      expect_min: 1
  `),
        /unsupported type .* for mongodb/
      );
    });

    it("rejects executable MongoDB filter operators", () => {
      assert.throws(
        () =>
          validateRevenantYaml(`  plan: bad
  database:
    engine: mongodb
    connection: \${MONGODB_URI}
    name: app
  checks:
    - type: document_count
      collection: users
      min: 0
      filter:
        $where: "return true"
  `),
        /\$where is not allowed/
      );
    });

    it("redacts MongoDB credentials and secret-valued JSON properties", () => {
      const redacted = redactSchemaSecrets(
        `mongodb+srv://readonly:secret%40word@cluster.example.net/app
  {"password":"s3cret","email":"person@example.com"}`
      );
      assert.doesNotMatch(redacted, /secret%40word|s3cret/);
      assert.match(redacted, /mongodb\+srv:\/\/\*\*\*@cluster/);
      assert.match(redacted, /"email":"person@example.com"/);
    });
  });

  it("maps account table to users when accounts does not exist", () => {
    const mapped = resolveAccountTables(analysis!.tables, intent);
    assert.deepEqual(
      mapped.map((t) => t.name),
      ["users"]
    );
  });

  it("honors created_at, updated_at, and account (users) without inventing tables", () => {
    const composed = composeYamlFromSchema(analysis!, {
      planName: "default",
      layers,
      intent,
    });
    const validated = validateRevenantYaml(composed.yamlText);
    const yaml = validated.yamlText;
    const realTables = new Set(analysis!.tables.map((t) => t.name));

    assert.doesNotMatch(yaml, /\baccounts\b/);
    assert.doesNotMatch(yaml, /\borders\b/);
    assert.doesNotMatch(yaml, /\bcustomers\b/);

    const schemaBlock = yaml.match(/expect_tables:\n([\s\S]*?)\n  - type:/);
    assert.ok(schemaBlock);
    const listed = [...schemaBlock[1].matchAll(/- (\S+)/g)].map((m) => m[1]);
    for (const name of listed) {
      assert.ok(realTables.has(name), `invented table ${name}`);
    }
    assert.ok(listed.includes("users"));

    assert.match(
      yaml,
      /type: freshness\n    table: users\n    column: created_at/
    );
    assert.match(
      yaml,
      /type: freshness\n    table: users\n    column: updated_at/
    );
    assert.match(yaml, /SELECT count\(\*\) FROM users/);
    assert.match(
      yaml,
      /WHERE created_at IS NOT NULL AND updated_at IS NOT NULL/
    );
    assert.match(yaml, /type: row_count\n    table: users\n    min: 1/);
  });
});
