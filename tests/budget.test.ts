import assert from "node:assert/strict";
import test from "node:test";

import { BudgetTracker } from "../src/budget.ts";
import type { BudgetConfig } from "../src/config.ts";

function createConfig(overrides: Partial<BudgetConfig> = {}): BudgetConfig {
  return {
    model: "anthropic/claude-haiku-4-5",
    max_input_tokens: 8000,
    max_output_tokens: 2000,
    context_summary_max_tokens: 500,
    max_turns: 5,
    max_session_cost_cents: 50,
    context_strategy: "truncate",
    ...overrides,
  };
}

test("record updates token, turn, cost, and tool counters", () => {
  const tracker = new BudgetTracker(createConfig());

  tracker.record(2_847, 342, "web_search");

  const stats = tracker.getStats();

  assert.equal(stats.inputTokens, 2_847);
  assert.equal(stats.outputTokens, 342);
  assert.equal(stats.turns, 1);
  assert.equal(stats.toolCalls, 1);
  assert.equal(stats.toolUsage.web_search, 1);
  assert.equal(stats.costCents, 0.113925);
});

test("formatInline returns the expected footer format", () => {
  const tracker = new BudgetTracker(createConfig());

  tracker.record(2_847, 342, "web_search");
  tracker.record(0, 0, "web_search");

  assert.equal(
    tracker.formatInline(),
    "📊 session in: 2,847 | out: 342 | tools: 2 | cost: $0.001",
  );
});

test("reset clears counters and starts a new session", async () => {
  const tracker = new BudgetTracker(createConfig());

  tracker.record(500, 250, "web_search");
  const beforeReset = tracker.getStats().startedAt;

  await new Promise((resolve) => setTimeout(resolve, 10));
  tracker.reset();

  const stats = tracker.getStats();

  assert.equal(stats.inputTokens, 0);
  assert.equal(stats.outputTokens, 0);
  assert.equal(stats.toolCalls, 0);
  assert.equal(stats.costCents, 0);
  assert.equal(stats.turns, 0);
  assert.deepEqual(stats.toolUsage, {});
  assert.notEqual(stats.startedAt.getTime(), beforeReset.getTime());
});

test("record uses model override for cost calculation when provided", () => {
  const tracker = new BudgetTracker(createConfig()); // default = haiku

  // Record with Sonnet override — 300/1M input, 1500/1M output
  tracker.record(1_000_000, 1_000_000, undefined, "anthropic/claude-sonnet-4-6");

  const stats = tracker.getStats();
  // Sonnet: 300 cents input + 1500 cents output = 1800 cents
  assert.equal(stats.costCents, 1800);
});

test("record uses config model when no override provided", () => {
  const tracker = new BudgetTracker(createConfig()); // haiku: 25/1M input, 125/1M output

  tracker.record(1_000_000, 1_000_000);

  const stats = tracker.getStats();
  // Haiku: 25 cents input + 125 cents output = 150 cents
  assert.equal(stats.costCents, 150);
});

test("record tracks repeated tool usage by tool name", () => {
  const tracker = new BudgetTracker(createConfig());

  tracker.record(100, 25, "web_search");
  tracker.record(100, 25, "web_search");
  tracker.record(100, 25, "example_service");

  assert.deepEqual(tracker.getStats().toolUsage, {
    example_service: 1,
    web_search: 2,
  });
});

test("record uses Gemini pricing when configured", () => {
  const tracker = new BudgetTracker(createConfig({
    model: "google/gemini-3-flash",
  }));

  tracker.record(1_000_000, 1_000_000);

  const stats = tracker.getStats();
  assert.equal(stats.costCents, 350);
});

test("record uses Gemini Pro pricing when overridden", () => {
  const tracker = new BudgetTracker(createConfig());

  tracker.record(1_000_000, 1_000_000, undefined, "google/gemini-3.1-pro");

  const stats = tracker.getStats();
  assert.equal(stats.costCents, 1400);
});

test("record resolves preview model variants to their base rate", () => {
  const tracker = new BudgetTracker(createConfig({
    model: "google/gemini-3-flash-preview",
  }));

  tracker.record(1_000_000, 1_000_000);

  const stats = tracker.getStats();
  assert.equal(stats.costCents, 350);
});
