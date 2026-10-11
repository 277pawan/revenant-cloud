import assert from "node:assert/strict";
import test from "node:test";
import {
  createDatabaseSchema,
  updateDatabaseSchema,
} from "./databases.schema.js";

const mongoUri =
  "mongodb+srv://validator:secret@cluster0.example.mongodb.net/?retryWrites=true&w=majority";

test("database creation accepts MongoDB direct mode and requires its URI and database", () => {
  const parsed = createDatabaseSchema.safeParse({
    name: "Atlas production",
    engine: "mongodb",
    databaseName: "app",
    connectionString: mongoUri,
  });
  assert.equal(parsed.success, true);
  if (parsed.success) {
    assert.equal(parsed.data.connectionString, mongoUri);
    assert.equal(parsed.data.recoveryMode, "direct");
    assert.equal(parsed.data.region, undefined);
  }

  assert.equal(
    createDatabaseSchema.safeParse({
      name: "Atlas without URI",
      engine: "mongodb",
      recoveryMode: "direct",
      databaseName: "app",
    }).success,
    false
  );
  assert.equal(
    createDatabaseSchema.safeParse({
      name: "Atlas without database",
      engine: "mongodb",
      recoveryMode: "direct",
      connectionString: mongoUri,
    }).success,
    false
  );
  assert.equal(
    createDatabaseSchema.safeParse({
      name: "Atlas with password field",
      engine: "mongodb",
      recoveryMode: "direct",
      databaseName: "app",
      connectionString: mongoUri,
      password: "misrouted",
    }).success,
    false
  );
});

test("database updates accept replacement MongoDB URIs and reject malformed URIs", () => {
  assert.equal(
    updateDatabaseSchema.safeParse({ connectionString: mongoUri }).success,
    true
  );
  assert.equal(
    updateDatabaseSchema.safeParse({ connectionString: "postgres://bad" }).success,
    false
  );
  assert.equal(
    updateDatabaseSchema.safeParse({
      engine: "mongodb",
      databaseName: "",
    }).success,
    false
  );
});

test("MongoDB databases reject AWS/RDS restore mode on create and update", () => {
  assert.equal(
    createDatabaseSchema.safeParse({
      name: "Atlas",
      engine: "mongodb",
      recoveryMode: "aws-rds",
      databaseName: "app",
      connectionString: mongoUri,
    }).success,
    false
  );
  assert.equal(
    updateDatabaseSchema.safeParse({
      engine: "mongodb",
      recoveryMode: "aws-rds",
    }).success,
    false
  );
});

test("MongoDB registration rejects region, host credentials, and AWS/RDS settings", () => {
  for (const unsupported of [
    { region: "us-east-1" },
    { host: "cluster0.example.mongodb.net" },
    { username: "validator" },
    { recoveryUseFreetier: true },
    { rdsSourceIdentifier: "production-db" },
    { awsAccessKeyId: "AKIAEXAMPLE" },
    { recoveryDrillsEnabled: false },
  ]) {
    assert.equal(
      createDatabaseSchema.safeParse({
        name: "Atlas",
        engine: "mongodb",
        databaseName: "app",
        connectionString: mongoUri,
        ...unsupported,
      }).success,
      false,
      `accepted unsupported MongoDB setting ${Object.keys(unsupported)[0]}`
    );
    assert.equal(
      updateDatabaseSchema.safeParse({
        engine: "mongodb",
        ...unsupported,
      }).success,
      false,
      `accepted unsupported MongoDB update ${Object.keys(unsupported)[0]}`
    );
  }
});

test("existing SQL database validation inputs remain accepted", () => {
  assert.equal(
    createDatabaseSchema.safeParse({
      name: "Postgres",
      engine: "postgres",
      host: "db.example",
      username: "validator",
      password: "secret",
      recoveryMode: "direct",
    }).success,
    true
  );
  assert.equal(
    updateDatabaseSchema.safeParse({
      engine: "mysql",
      password: "new-secret",
    }).success,
    true
  );
});
