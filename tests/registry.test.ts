import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ToolRegistry, validateToolArgs } from "../src/registry.ts";

function createToolsDir(): string {
  return mkdtempSync(path.join(tmpdir(), "newsteam-registry-test-"));
}

function addMockTool(
  toolsDir: string,
  dirName: string,
  manifest: Record<string, unknown>,
): void {
  const toolDir = path.join(toolsDir, dirName);
  mkdirSync(toolDir, { recursive: true });
  writeFileSync(
    path.join(toolDir, "manifest.json"),
    JSON.stringify(manifest),
    "utf8",
  );
}

const VALID_MANIFEST = {
  name: "web_search",
  description: "Search the web",
  parameters: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  },
  secrets: ["BRAVE_API_KEY"],
  timeout_ms: 10000,
  handler: "handler.py",
  runtime: "python",
};

test("loadAll loads valid manifests from tool directories", () => {
  const toolsDir = createToolsDir();
  addMockTool(toolsDir, "web-search", VALID_MANIFEST);

  const registry = new ToolRegistry(toolsDir);
  registry.loadAll();

  assert.equal(registry.getAll().length, 1);
  assert.deepEqual(registry.get("web_search"), VALID_MANIFEST);
});

test("loadAll can skip tools whose declared secrets are unavailable", () => {
  const toolsDir = createToolsDir();
  addMockTool(toolsDir, "web-search", VALID_MANIFEST);
  addMockTool(toolsDir, "web-fetch", {
    ...VALID_MANIFEST,
    name: "web_fetch",
    secrets: [],
  });

  const previous = process.env.BRAVE_API_KEY;
  delete process.env.BRAVE_API_KEY;
  try {
    const registry = new ToolRegistry(toolsDir);
    registry.loadAll({ availableSecretsOnly: true });

    assert.equal(registry.get("web_search"), undefined);
    assert.ok(registry.get("web_fetch"));
  } finally {
    if (previous === undefined) {
      delete process.env.BRAVE_API_KEY;
    } else {
      process.env.BRAVE_API_KEY = previous;
    }
  }
});

test("loadAll skips tool directories without manifest.json", () => {
  const toolsDir = createToolsDir();
  mkdirSync(path.join(toolsDir, "disabled-tool"));
  addMockTool(toolsDir, "active-tool", VALID_MANIFEST);

  const registry = new ToolRegistry(toolsDir);
  registry.loadAll();

  assert.equal(registry.getAll().length, 1);
  assert.ok(registry.get("web_search"));
});

test("loadAll throws when manifest is missing a required field", () => {
  const toolsDir = createToolsDir();
  const incomplete = { ...VALID_MANIFEST };
  delete (incomplete as Record<string, unknown>).description;
  addMockTool(toolsDir, "bad-tool", incomplete);

  const registry = new ToolRegistry(toolsDir);

  assert.throws(
    () => registry.loadAll(),
    { message: 'Tool "bad-tool" manifest is missing required field: description' },
  );
});

test("getToolSchemas returns Anthropic-compatible tool definitions", () => {
  const toolsDir = createToolsDir();
  addMockTool(toolsDir, "web-search", VALID_MANIFEST);

  const registry = new ToolRegistry(toolsDir);
  registry.loadAll();

  const schemas = registry.getToolSchemas();

  assert.equal(schemas.length, 1);
  assert.deepEqual(schemas[0], {
    name: "web_search",
    description: "Search the web",
    input_schema: VALID_MANIFEST.parameters,
  });
});

test("loadAll handles empty tools directory gracefully", () => {
  const toolsDir = createToolsDir();

  const registry = new ToolRegistry(toolsDir);
  registry.loadAll();

  assert.equal(registry.getAll().length, 0);
});

test("loadAll handles non-existent tools directory gracefully", () => {
  const registry = new ToolRegistry("/tmp/does-not-exist-newsteam");
  registry.loadAll();

  assert.equal(registry.getAll().length, 0);
});

test("validateToolArgs accepts valid args", () => {
  const result = validateToolArgs(
    {
      query: "lobster facts",
      limit: 3,
      mode: "web",
    },
    {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number" },
        mode: { type: "string", enum: ["web", "news"] },
      },
      required: ["query", "limit"],
    },
  );

  assert.equal(result, null);
});

test("validateToolArgs rejects missing required fields", () => {
  const result = validateToolArgs(
    {},
    {
      type: "object",
      properties: {
        query: { type: "string" },
      },
      required: ["query"],
    },
  );

  assert.equal(result, "Missing required field: query");
});

test("validateToolArgs rejects wrong types", () => {
  const result = validateToolArgs(
    { limit: "3" },
    {
      type: "object",
      properties: {
        limit: { type: "number" },
      },
    },
  );

  assert.equal(result, 'Invalid type for "limit": expected number');
});

test("validateToolArgs rejects invalid enum values", () => {
  const result = validateToolArgs(
    { mode: "images" },
    {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["web", "news"] },
      },
    },
  );

  assert.equal(result, 'Invalid value for "mode": expected one of "web", "news"');
});

test("loadAll loads manifests with optional fields (requires_confirmation, output_schema, max_calls_per_hour)", () => {
  const toolsDir = createToolsDir();
  const manifestWithOptionals = {
    ...VALID_MANIFEST,
    name: "post_tool",
    requires_confirmation: true,
    output_schema: {
      type: "object",
      required: ["status", "id"],
    },
    max_calls_per_hour: 10,
  };
  addMockTool(toolsDir, "post-tool", manifestWithOptionals);

  const registry = new ToolRegistry(toolsDir);
  registry.loadAll();

  const loaded = registry.get("post_tool");
  assert.ok(loaded);
  assert.equal(loaded.requires_confirmation, true);
  assert.deepEqual(loaded.output_schema, { type: "object", required: ["status", "id"] });
  assert.equal(loaded.max_calls_per_hour, 10);
});

test("loadAll loads manifests without optional fields (backward compat)", () => {
  const toolsDir = createToolsDir();
  addMockTool(toolsDir, "web-search", VALID_MANIFEST);

  const registry = new ToolRegistry(toolsDir);
  registry.loadAll();

  const loaded = registry.get("web_search");
  assert.ok(loaded);
  assert.equal(loaded.requires_confirmation, undefined);
  assert.equal(loaded.output_schema, undefined);
  assert.equal(loaded.max_calls_per_hour, undefined);
});
