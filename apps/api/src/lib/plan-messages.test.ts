import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  messageParallelDrillLimit,
  messageSelfHostedAgentBlocked,
  messageSubscriptionInactive,
  messageWorkflowLimit,
} from "./plan-messages.js";

describe("plan-messages", () => {
  it("subscription inactive mentions trial and price", () => {
    const msg = messageSubscriptionInactive({
      plan: "starter",
      subscriptionStatus: "trialing",
      trialEndsAt: new Date("2020-01-01"),
    });
    assert.match(msg, /30-day/);
    assert.match(msg, /₹999/);
    assert.match(msg, /Developer CLI/);
  });

  it("workflow limit mentions Starter count and Pro upgrade", () => {
    const msg = messageWorkflowLimit("starter", 1);
    assert.match(msg, /1 production workflow/);
    assert.match(msg, /Pro/);
  });

  it("parallel drill limit is friendly for Starter", () => {
    const msg = messageParallelDrillLimit("starter", 1);
    assert.match(msg, /one restore drill at a time/i);
  });

  it("agent blocked on Starter points to Workflows", () => {
    const msg = messageSelfHostedAgentBlocked("starter");
    assert.match(msg, /managed drills/i);
    assert.match(msg, /Workflows/);
  });
});
