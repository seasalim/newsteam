import assert from "node:assert/strict";
import test from "node:test";

import {
  estimateCostCents,
  formatDollarsFromCents,
  isKnownCostModel,
  resolveModelCostRate,
} from "../src/model-cost.ts";

test("resolveModelCostRate returns the exact rate for a known model", () => {
  assert.deepEqual(resolveModelCostRate("google/gemini-3-flash"), {
    inputPer1M: 50,
    outputPer1M: 300,
  });
});

test("resolveModelCostRate resolves preview variants to the base model rate", () => {
  assert.deepEqual(resolveModelCostRate("google/gemini-3-flash-preview"), {
    inputPer1M: 50,
    outputPer1M: 300,
  });
  assert.deepEqual(resolveModelCostRate("google/gemini-3.1-pro-preview"), {
    inputPer1M: 200,
    outputPer1M: 1200,
  });
});

test("resolveModelCostRate resolves dated variants to the base model rate", () => {
  assert.deepEqual(resolveModelCostRate("anthropic/claude-haiku-4-5-20251001"), {
    inputPer1M: 25,
    outputPer1M: 125,
  });
});

test("resolveModelCostRate returns current OpenAI model rates", () => {
  assert.deepEqual(resolveModelCostRate("openai/gpt-5.4-mini"), {
    inputPer1M: 75,
    outputPer1M: 450,
  });
  assert.deepEqual(resolveModelCostRate("openai/gpt-5.4"), {
    inputPer1M: 250,
    outputPer1M: 1500,
  });
  assert.deepEqual(resolveModelCostRate("openai/gpt-5.6-sol"), {
    inputPer1M: 500,
    outputPer1M: 3000,
  });
  assert.deepEqual(resolveModelCostRate("openai/gpt-5.6-terra"), {
    inputPer1M: 250,
    outputPer1M: 1500,
  });
  assert.deepEqual(resolveModelCostRate("openai/gpt-5.6-luna"), {
    inputPer1M: 100,
    outputPer1M: 600,
  });
});

test("resolveModelCostRate does not prefix-match without a variant boundary", () => {
  assert.equal(resolveModelCostRate("google/gemini-3-flashlite"), null);
});

test("resolveModelCostRate returns null for unknown models", () => {
  assert.equal(resolveModelCostRate("openai/gpt-6"), null);
});

test("isKnownCostModel reflects rate resolution", () => {
  assert.equal(isKnownCostModel("google/gemini-3.1-pro-preview"), true);
  assert.equal(isKnownCostModel("mystery/model-9"), false);
});

test("estimateCostCents computes cost from the resolved rate", () => {
  // Flash preview resolves to flash: 50 + 300 = 350 cents per 1M each way
  assert.equal(estimateCostCents("google/gemini-3-flash-preview", 1_000_000, 1_000_000), 350);
});

test("estimateCostCents falls back to the default rate for unknown models", () => {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };

  try {
    // Default rate: 25 + 125 = 150 cents per 1M each way
    assert.equal(estimateCostCents("mystery/model-9", 1_000_000, 1_000_000), 150);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /No cost rate for model "mystery\/model-9"/);

    // Warns only once per model
    estimateCostCents("mystery/model-9", 1_000_000, 1_000_000);
    assert.equal(warnings.length, 1);
  } finally {
    console.warn = originalWarn;
  }
});

test("formatDollarsFromCents formats cents as dollars with three decimals", () => {
  assert.equal(formatDollarsFromCents(350), "3.500");
  assert.equal(formatDollarsFromCents(0.113925), "0.001");
});
