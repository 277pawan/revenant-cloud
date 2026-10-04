import assert from "node:assert/strict";
import test from "node:test";
import {
  isAwsCredentialError,
  normalizeAwsIamCredentials,
} from "./aws-credentials.js";
import { updateDatabaseSchema } from "../validations/databases.schema.js";

test("normalizes whitespace around AWS credentials and preserves the session token", () => {
  assert.deepEqual(
    normalizeAwsIamCredentials({
      accessKeyId: " ASIAEXAMPLE ",
      secretAccessKey: " example-secret ",
      sessionToken: " example-session-token ",
    }),
    {
      accessKeyId: "ASIAEXAMPLE",
      secretAccessKey: "example-secret",
      sessionToken: "example-session-token",
    }
  );
});

test("requires a session token for temporary AWS access keys", () => {
  assert.throws(
    () =>
      normalizeAwsIamCredentials({
        accessKeyId: "ASIAEXAMPLE",
        secretAccessKey: "example-secret",
      }),
    /Temporary AWS credentials require a session token/
  );
});

test("allows permanent AWS access keys without a session token", () => {
  assert.deepEqual(
    normalizeAwsIamCredentials({
      accessKeyId: "AKIAEXAMPLE",
      secretAccessKey: "example-secret",
    }),
    {
      accessKeyId: "AKIAEXAMPLE",
      secretAccessKey: "example-secret",
    }
  );
});

test("recognizes AWS invalid and expired credential errors", () => {
  assert.equal(
    isAwsCredentialError(
      new Error("The security token included in the request is invalid.")
    ),
    true
  );
  assert.equal(isAwsCredentialError({ name: "ExpiredToken" }), true);
  assert.equal(isAwsCredentialError({ name: "AccessDeniedException" }), false);
});

test("accepts AWS session tokens longer than the old 256-character limit", () => {
  assert.equal(
    updateDatabaseSchema.safeParse({ awsSessionToken: "x".repeat(512) }).success,
    true
  );
});
