import assert from "node:assert/strict";
import test from "node:test";
import { redisHistoryPageQuerySchema } from "./redis.schema.js";

test("Redis history pagination defaults to a bounded first page", () => {
  assert.deepEqual(redisHistoryPageQuerySchema.parse({}), {
    offset: 0,
    limit: 10,
    search: "",
  });
});

test("Redis history pagination accepts bounded offsets, limits, and search", () => {
  assert.deepEqual(
    redisHistoryPageQuerySchema.parse({
      offset: "20",
      limit: "25",
      search: " pending ",
    }),
    { offset: 20, limit: 25, search: "pending" }
  );
});

test("Redis history pagination rejects unsafe or unbounded values", () => {
  assert.equal(redisHistoryPageQuerySchema.safeParse({ offset: "-1" }).success, false);
  assert.equal(redisHistoryPageQuerySchema.safeParse({ limit: "101" }).success, false);
  assert.equal(
    redisHistoryPageQuerySchema.safeParse({ search: "x".repeat(101) }).success,
    false
  );
});
