import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { EventLogger } from "../src/logger.ts";

function createTempLogger(): { logger: EventLogger; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "newsteam-logger-test-"));
  return { logger: new EventLogger(dir), dir };
}

test("emit() creates daily log file in temp directory", () => {
  const { logger, dir } = createTempLogger();

  logger.emit("test.event", { key: "value" });

  const today = new Date().toISOString().slice(0, 10);
  const logPath = path.join(dir, `events-${today}.jsonl`);
  const content = readFileSync(logPath, "utf8");

  assert.ok(content.length > 0);
});

test("emit() appends valid JSON lines", () => {
  const { logger, dir } = createTempLogger();

  logger.emit("test.event", { key: "value" });

  const today = new Date().toISOString().slice(0, 10);
  const logPath = path.join(dir, `events-${today}.jsonl`);
  const content = readFileSync(logPath, "utf8");
  const lines = content.trim().split("\n");

  assert.equal(lines.length, 1);

  // Should parse as valid JSON
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.event, "test.event");
  assert.deepEqual(parsed.data, { key: "value" });
});

test("multiple events produce multiple lines", () => {
  const { logger, dir } = createTempLogger();

  logger.emit("event.one", { a: 1 });
  logger.emit("event.two", { b: 2 });
  logger.emit("event.three");

  const today = new Date().toISOString().slice(0, 10);
  const logPath = path.join(dir, `events-${today}.jsonl`);
  const content = readFileSync(logPath, "utf8");
  const lines = content.trim().split("\n");

  assert.equal(lines.length, 3);

  const parsed0 = JSON.parse(lines[0]);
  assert.equal(parsed0.event, "event.one");

  const parsed1 = JSON.parse(lines[1]);
  assert.equal(parsed1.event, "event.two");

  const parsed2 = JSON.parse(lines[2]);
  assert.equal(parsed2.event, "event.three");
  assert.deepEqual(parsed2.data, {});
});

test("getLogPath() returns correct path format", () => {
  const { logger, dir } = createTempLogger();

  const today = new Date();
  const expectedDate = today.toISOString().slice(0, 10);
  const expectedPath = path.join(dir, `events-${expectedDate}.jsonl`);

  assert.equal(logger.getLogPath(today), expectedPath);
});

test("getLogPath() with custom date returns correct path", () => {
  const { logger, dir } = createTempLogger();

  const customDate = new Date("2026-01-15T12:00:00Z");
  const expectedPath = path.join(dir, "events-2026-01-15.jsonl");

  assert.equal(logger.getLogPath(customDate), expectedPath);
});

test("events have correct structure (ts, event, data fields)", () => {
  const { logger, dir } = createTempLogger();

  logger.emit("agent.chat.start", { message_length: 42 });

  const today = new Date().toISOString().slice(0, 10);
  const logPath = path.join(dir, `events-${today}.jsonl`);
  const content = readFileSync(logPath, "utf8");
  const parsed = JSON.parse(content.trim());

  assert.ok("ts" in parsed);
  assert.ok("event" in parsed);
  assert.ok("data" in parsed);
  assert.equal(typeof parsed.ts, "string");
  assert.ok(parsed.ts.endsWith("Z"));
  assert.equal(parsed.event, "agent.chat.start");
  assert.equal(parsed.data.message_length, 42);
});
