export type ValidationPlanTemplate = {
  id: string;
  name: string;
  description: string;
  tags: string[];
  yamlText: string;
};

export const VALIDATION_PLAN_TEMPLATES: ValidationPlanTemplate[] = [
  {
    id: "aws-freetier",
    name: "AWS RDS free tier",
    description:
      "Snapshot → sandbox restore → schema, row counts, FKs, freshness, and golden query checks.",
    tags: ["postgres", "aws-rds", "starter"],
    yamlText: `plan: aws-free-tier-validation

database:
  engine: postgres
  connection: postgres://\${SANDBOX_USER}:\${SANDBOX_PASSWORD}@\${SANDBOX_ENDPOINT}:5432/\${SANDBOX_DBNAME}?sslmode=require

recovery:
  engine: aws-rds
  source_identifier: database-1
  region: eu-west-2
  use_freetier: true
  max_sandbox_age: 2h

checks:
  - type: connect
  - type: schema
    expect_tables:
      - customers
      - orders
  - type: row_count
    table: customers
    min: 1
  - type: row_count
    table: orders
    min: 1
  - type: foreign_key
    table: orders
    references: customers
  - type: freshness
    table: orders
    column: created_at
    max_age: 24h
  - type: golden_query
    query: "SELECT COUNT(*) FROM orders WHERE created_at > NOW() - INTERVAL '7 days'"
    expect_min: 1
`,
  },
  {
    id: "cloud-postgres",
    name: "Cloud Postgres (direct)",
    description: "Connect to a live Postgres URL — connect, schema, and row-count smoke checks.",
    tags: ["postgres", "direct"],
    yamlText: `plan: cloud-validation

database:
  engine: postgres
  connection: \${DATABASE_URL}

checks:
  - type: connect
  - type: schema
    expect_tables:
      - customers
  - type: row_count
    table: customers
    min: 1
`,
  },
];

export function getValidationTemplate(id: string): ValidationPlanTemplate | undefined {
  return VALIDATION_PLAN_TEMPLATES.find((t) => t.id === id);
}
