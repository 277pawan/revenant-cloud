import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { STARTER_TRIAL_DAYS } from "@revenant/shared";
import { trialEndsAtFromNow } from "./org-subscription.js";

describe("Starter trial duration", () => {
  it("uses the 90-day trial duration for new trial deadlines", () => {
    const startedAt = Date.now();
    const trialEndsAt = trialEndsAtFromNow();
    const finishedAt = Date.now();

    assert.equal(STARTER_TRIAL_DAYS, 90);
    assert.ok(
      trialEndsAt.getTime() >= startedAt + 90 * 24 * 60 * 60 * 1000 &&
        trialEndsAt.getTime() <= finishedAt + 90 * 24 * 60 * 60 * 1000
    );
  });
});
