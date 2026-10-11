import assert from "node:assert/strict";
import test from "node:test";
import { claimDatabaseSecret } from "./jobs.service.js";

const mongoUri = "mongodb+srv://validator:secret@cluster0.example.mongodb.net/app";

test("runner claim payload carries a MongoDB URI only in the secret connectionString field", () => {
  const claimedSecret = claimDatabaseSecret("mongodb", mongoUri);
  assert.deepEqual(claimedSecret, {
    password: null,
    connectionString: mongoUri,
  });
  assert.equal(claimedSecret.password, null);
  assert.notEqual(JSON.stringify(claimedSecret), JSON.stringify({ password: mongoUri }));
});

test("SQL runner claims retain their existing password field and never include a URI", () => {
  assert.deepEqual(claimDatabaseSecret("postgres", "sql-password"), {
    password: "sql-password",
  });
});
