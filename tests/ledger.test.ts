import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { CostLedger } from "../src/ledger.ts";

function createTempLedger(): CostLedger {
  const dir = mkdtempSync(path.join(tmpdir(), "newsteam-ledger-test-"));
  return new CostLedger(dir);
}

test("record() creates a JSONL file in the ledger directory", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "newsteam-ledger-test-"));
  const ledger = new CostLedger(dir);

  ledger.record({
    inputTokens: 1000,
    outputTokens: 500,
    costCents: 0.5,
    turns: 1,
    toolCalls: 2,
  });

  const filePath = path.join(dir, "cost-ledger.jsonl");
  const content = readFileSync(filePath, "utf8");
  const lines = content.trim().split("\n");

  assert.equal(lines.length, 1);

  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.input_tokens, 1000);
  assert.equal(parsed.output_tokens, 500);
  assert.equal(parsed.cost_cents, 0.5);
  assert.equal(parsed.turns, 1);
  assert.equal(parsed.tool_calls, 2);
  assert.equal(parsed.date, new Date().toISOString().slice(0, 10));
});

test("record() accumulates values for the same day", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "newsteam-ledger-test-"));
  const ledger = new CostLedger(dir);

  ledger.record({
    inputTokens: 1000,
    outputTokens: 500,
    costCents: 0.5,
    turns: 1,
    toolCalls: 2,
  });

  ledger.record({
    inputTokens: 2000,
    outputTokens: 1000,
    costCents: 1.0,
    turns: 3,
    toolCalls: 5,
  });

  const filePath = path.join(dir, "cost-ledger.jsonl");
  const content = readFileSync(filePath, "utf8");
  const lines = content.trim().split("\n");

  assert.equal(lines.length, 1);

  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.input_tokens, 3000);
  assert.equal(parsed.output_tokens, 1500);
  assert.equal(parsed.cost_cents, 1.5);
  assert.equal(parsed.turns, 4);
  assert.equal(parsed.tool_calls, 7);
});

test("getTodayCost() returns today's cumulative values", () => {
  const ledger = createTempLedger();

  ledger.record({
    inputTokens: 5000,
    outputTokens: 2000,
    costCents: 1.234,
    turns: 3,
    toolCalls: 1,
  });

  const today = ledger.getTodayCost();
  assert.equal(today.costCents, 1.234);
  assert.equal(today.turns, 3);
});

test("getTodayCost() returns zeros when no data exists", () => {
  const ledger = createTempLedger();

  const today = ledger.getTodayCost();
  assert.equal(today.costCents, 0);
  assert.equal(today.turns, 0);
});

test("getMonthCost() sums across multiple days in the same month", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "newsteam-ledger-test-"));
  const ledger = new CostLedger(dir);

  // Write multiple days manually to simulate multi-day data
  const today = new Date().toISOString().slice(0, 10);
  const monthPrefix = today.slice(0, 7);
  const day1 = `${monthPrefix}-01`;
  const day2 = `${monthPrefix}-02`;

  const filePath = path.join(dir, "cost-ledger.jsonl");
  const lines = [
    JSON.stringify({ date: day1, input_tokens: 1000, output_tokens: 500, cost_cents: 0.5, turns: 2, tool_calls: 1 }),
    JSON.stringify({ date: day2, input_tokens: 2000, output_tokens: 1000, cost_cents: 1.0, turns: 3, tool_calls: 2 }),
  ];

  writeFileSync(filePath, lines.join("\n") + "\n", "utf8");

  const month = ledger.getMonthCost();
  assert.equal(month.costCents, 1.5);
  assert.equal(month.turns, 5);
  assert.equal(month.days, 2);
});

test("formatCostReport() returns expected string format", () => {
  const ledger = createTempLedger();

  ledger.record({
    inputTokens: 45000,
    outputTokens: 12000,
    costCents: 1.234,
    turns: 15,
    toolCalls: 8,
  });

  const report = ledger.formatCostReport();

  assert.ok(report.includes("Cost Ledger"));
  assert.ok(report.includes("Today:"));
  assert.ok(report.includes("Month:"));
  assert.ok(report.includes("$0.012"));
  assert.ok(report.includes("15 turns"));
  assert.ok(!report.includes("Budget:"));
});

test("formatCostReport() with monthly budget shows comparison", () => {
  const ledger = createTempLedger();

  ledger.record({
    inputTokens: 45000,
    outputTokens: 12000,
    costCents: 50.0,
    turns: 15,
    toolCalls: 8,
  });

  const report = ledger.formatCostReport(500);

  assert.ok(report.includes("Budget:"));
  assert.ok(report.includes("$0.500"));
  assert.ok(report.includes("$5.000"));
  assert.ok(report.includes("10.0%"));
});
