import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { MemoryManager } from "../src/memory.ts";

function createMemoryPath(fileName = "MEMORY.md"): string {
  const directory = mkdtempSync(path.join(tmpdir(), "newsteam-memory-test-"));
  return path.join(directory, fileName);
}

test("load returns empty string when the memory file does not exist", () => {
  const memoryPath = createMemoryPath();
  const manager = new MemoryManager(memoryPath, 100);

  assert.equal(manager.load(), "");
});

test("remember and flush write queued entries to disk", () => {
  const memoryPath = createMemoryPath();
  const manager = new MemoryManager(memoryPath, 100);

  manager.remember("User prefers dark mode");
  manager.remember("Favorite snack is seaweed chips");
  manager.flush();

  const contents = readFileSync(memoryPath, "utf8");
  assert.match(contents, /## general/u);
  assert.match(contents, /- User prefers dark mode/u);
  assert.match(contents, /- Favorite snack is seaweed chips/u);
  assert.equal(manager.getQueueSize(), 0);
});

test("flush drops oldest entries first when the memory file exceeds the token cap", () => {
  const memoryPath = createMemoryPath();
  const manager = new MemoryManager(memoryPath, 10);

  manager.remember("alpha");
  manager.remember("bravo");
  manager.remember("charlie");
  manager.remember("delta");
  manager.flush();

  const contents = readFileSync(memoryPath, "utf8");
  // Should keep the newest entries that fit within the token budget
  assert.match(contents, /- delta/u);
  // Oldest entries should be dropped
  assert.equal(contents.includes("- alpha"), false);
});

test("estimateTokens uses the four-characters-per-token heuristic", () => {
  const manager = new MemoryManager(createMemoryPath(), 100);

  assert.equal(manager.estimateTokens(""), 0);
  assert.equal(manager.estimateTokens("abcd"), 1);
  assert.equal(manager.estimateTokens("abcde"), 2);
  assert.equal(manager.estimateTokens("12345678"), 2);
});

test("flush is a no-op when there are no queued entries", () => {
  const memoryPath = createMemoryPath();
  const manager = new MemoryManager(memoryPath, 100);

  manager.flush();

  assert.equal(existsSync(memoryPath), false);
});

test("load reads back the contents that were written", () => {
  const memoryPath = createMemoryPath();
  const manager = new MemoryManager(memoryPath, 100);

  manager.remember("Tracks user timezone");
  manager.flush();

  const reloadedManager = new MemoryManager(memoryPath, 100);
  const contents = reloadedManager.load();
  assert.match(contents, /- Tracks user timezone/u);
});

test("flush truncates an oversized single entry and keeps it", () => {
  const memoryPath = createMemoryPath();
  const manager = new MemoryManager(memoryPath, 4);

  manager.remember("12345678901234567890");
  manager.flush();

  const contents = readFileSync(memoryPath, "utf8");
  assert.match(contents, /\.\.\./u);
});

test("flush creates parent directories when they do not exist", () => {
  const nestedMemoryPath = path.join(
    mkdtempSync(path.join(tmpdir(), "newsteam-memory-test-")),
    "persona",
    "nested",
    "MEMORY.md",
  );
  const manager = new MemoryManager(nestedMemoryPath, 100);

  manager.remember("Creates missing folders");
  manager.flush();

  const contents = readFileSync(nestedMemoryPath, "utf8");
  assert.match(contents, /- Creates missing folders/u);
});

test("empty flush does not modify an existing memory file", () => {
  const memoryPath = createMemoryPath();
  const manager = new MemoryManager(memoryPath, 100);

  manager.remember("Existing memory");
  manager.flush();
  const beforeStat = statSync(memoryPath);

  manager.flush();

  const afterStat = statSync(memoryPath);
  assert.match(readFileSync(memoryPath, "utf8"), /- Existing memory/u);
  assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
});

// --- Category tests ---

test("remember with category stores categorized entries", () => {
  const memoryPath = createMemoryPath();
  const manager = new MemoryManager(memoryPath, 200);

  manager.remember("User likes dark mode", "preference");
  manager.remember("Favorite snack is seaweed chips", "fact");
  manager.flush();

  const contents = readFileSync(memoryPath, "utf8");
  assert.match(contents, /## preference/u);
  assert.match(contents, /- User likes dark mode/u);
  assert.match(contents, /## fact/u);
  assert.match(contents, /- Favorite snack is seaweed chips/u);
});

test("flush writes entries organized by category sections", () => {
  const memoryPath = createMemoryPath();
  const manager = new MemoryManager(memoryPath, 500);

  manager.remember("Prefers vim", "preference");
  manager.remember("Works at Acme Corp", "fact");
  manager.remember("Knows Alice", "relationship");
  manager.remember("Decided to use TypeScript", "decision");
  manager.remember("Some general note");
  manager.flush();

  const contents = readFileSync(memoryPath, "utf8");
  assert.match(contents, /## preference\n- Prefers vim/u);
  assert.match(contents, /## fact\n- Works at Acme Corp/u);
  assert.match(contents, /## relationship\n- Knows Alice/u);
  assert.match(contents, /## decision\n- Decided to use TypeScript/u);
  assert.match(contents, /## general\n- Some general note/u);
});

test("flush handles mixed categorized and uncategorized entries", () => {
  const memoryPath = createMemoryPath();
  const manager = new MemoryManager(memoryPath, 500);

  manager.remember("First general note");
  manager.remember("A preference", "preference");
  manager.remember("Second general note");
  manager.flush();

  const contents = readFileSync(memoryPath, "utf8");
  assert.match(contents, /## general/u);
  assert.match(contents, /- First general note/u);
  assert.match(contents, /- Second general note/u);
  assert.match(contents, /## preference/u);
  assert.match(contents, /- A preference/u);
});

test("load and re-flush preserves category sections", () => {
  const memoryPath = createMemoryPath();
  const manager1 = new MemoryManager(memoryPath, 500);

  manager1.remember("Likes coffee", "preference");
  manager1.remember("Born in 1990", "fact");
  manager1.flush();

  const manager2 = new MemoryManager(memoryPath, 500);
  manager2.remember("Knows Bob", "relationship");
  manager2.flush();

  const contents = readFileSync(memoryPath, "utf8");
  assert.match(contents, /## preference\n- Likes coffee/u);
  assert.match(contents, /## fact\n- Born in 1990/u);
  assert.match(contents, /## relationship\n- Knows Bob/u);
});

test("search returns matching entries (case-insensitive)", () => {
  const memoryPath = createMemoryPath();
  const manager = new MemoryManager(memoryPath, 500);

  manager.remember("User likes dark mode", "preference");
  manager.remember("Favorite snack is seaweed chips", "fact");
  manager.remember("Works at Dark Industries", "fact");
  manager.flush();

  const results = manager.search("dark");
  assert.equal(results.length, 2);
  assert.ok(results.includes("User likes dark mode"));
  assert.ok(results.includes("Works at Dark Industries"));
});

test("search returns empty array when no matches", () => {
  const memoryPath = createMemoryPath();
  const manager = new MemoryManager(memoryPath, 500);

  manager.remember("User likes dark mode", "preference");
  manager.flush();

  const results = manager.search("python");
  assert.deepEqual(results, []);
});

test("search returns empty array when memory file does not exist", () => {
  const memoryPath = createMemoryPath();
  const manager = new MemoryManager(memoryPath, 500);

  const results = manager.search("anything");
  assert.deepEqual(results, []);
});

test("backward compat: flat format entries are treated as general", () => {
  const memoryPath = createMemoryPath();
  // Write old flat format directly
  writeFileSync(memoryPath, "- Old entry one\n- Old entry two", "utf8");

  const manager = new MemoryManager(memoryPath, 500);
  manager.remember("New entry", "preference");
  manager.flush();

  const contents = readFileSync(memoryPath, "utf8");
  // Old entries should be under general category
  assert.match(contents, /## general/u);
  assert.match(contents, /- Old entry one/u);
  assert.match(contents, /- Old entry two/u);
  // New entry should be under preference category
  assert.match(contents, /## preference/u);
  assert.match(contents, /- New entry/u);
});

test("remember with invalid category defaults to general", () => {
  const memoryPath = createMemoryPath();
  const manager = new MemoryManager(memoryPath, 200);

  manager.remember("Some note", "invalid_category" as string);
  manager.flush();

  const contents = readFileSync(memoryPath, "utf8");
  assert.match(contents, /## general/u);
  assert.match(contents, /- Some note/u);
  assert.equal(contents.includes("invalid_category"), false);
});
