import assert from "node:assert/strict";
import test from "node:test";
import {
  databaseCredentialForCreate,
  databaseCredentialForUpdate,
} from "./databases.service.js";
import { decryptSecret, encryptSecret } from "../lib/crypto.js";
import {
  createDatabaseSchema,
  updateDatabaseSchema,
} from "../validations/databases.schema.js";

const masterKey = Buffer.alloc(32, 7).toString("base64");
const mongoUri =
  "mongodb+srv://validator:secret@cluster0.example.mongodb.net/app?retryWrites=true";

test("MongoDB create stores the URI through the encrypted database-secret path", () => {
  const input = createDatabaseSchema.parse({
    name: "Atlas",
    engine: "mongodb",
    recoveryMode: "direct",
    databaseName: "app",
    connectionString: mongoUri,
  });
  const secret = databaseCredentialForCreate(input);
  assert.equal(secret, mongoUri);
  assert.equal(
    decryptSecret(encryptSecret(secret!, masterKey), masterKey),
    mongoUri
  );
  assert.equal(databaseCredentialForCreate({
    name: "Postgres",
    engine: "postgres",
    host: "db.example",
    password: "sql-password",
    recoveryMode: "direct",
  }), "sql-password");
});

test("MongoDB update replaces the encrypted secret without changing SQL password handling", () => {
  const updatedUri = `${mongoUri}&appName=updated`;
  const input = updateDatabaseSchema.parse({ connectionString: updatedUri });
  const secret = databaseCredentialForUpdate("mongodb", input);
  assert.equal(
    decryptSecret(encryptSecret(secret!, masterKey), masterKey),
    updatedUri
  );

  const sqlUpdate = updateDatabaseSchema.parse({ password: "next-password" });
  assert.equal(
    databaseCredentialForUpdate("postgres", sqlUpdate),
    "next-password"
  );
  assert.equal(databaseCredentialForUpdate("mongodb", sqlUpdate), null);
});
