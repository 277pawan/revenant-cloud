import assert from "node:assert/strict";
import test from "node:test";

import {
  isMissingDatabaseObjectError,
  migrationRequiredMessage,
} from "./pg-errors.js";

test("missing Redis tables point to the Redis schema migration", () => {
  assert.equal(
    migrationRequiredMessage("Failed to list Redis resources"),
    "Failed to list Redis resources requires database migration 0026_redis_resources. Run: npm run db:migrate -w @revenant/api"
  );
});

test("missing relations and columns are treated as schema migration errors", () => {
  assert.equal(isMissingDatabaseObjectError({ code: "42P01" }), true);
  assert.equal(isMissingDatabaseObjectError({ code: "42703" }), true);
  assert.equal(isMissingDatabaseObjectError({ code: "23505" }), false);
});

test("Redis proof detail errors identify the proof-check migration", () => {
  assert.match(
    migrationRequiredMessage("Failed to list Redis proofs", {
      message: 'column "checks_json" does not exist',
    }),
    /0030_redis_proof_checks/
  );
});
