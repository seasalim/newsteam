import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ToolExecutor } from "../src/executor.ts";
import type { ToolManifest } from "../src/registry.ts";

function createToolFixture(
  handlerCode: string,
  overrides: Partial<ToolManifest> = {},
): { toolsDir: string; manifest: ToolManifest } {
  const toolsDir = mkdtempSync(path.join(tmpdir(), "newsteam-executor-test-"));
  const toolDir = path.join(toolsDir, "echo-tool");
  mkdirSync(toolDir, { recursive: true });
  writeFileSync(path.join(toolDir, "handler.py"), handlerCode, "utf8");

  const manifest: ToolManifest = {
    name: "echo_tool",
    description: "Echoes input",
    parameters: { type: "object", properties: {} },
    secrets: [],
    timeout_ms: 5000,
    handler: "handler.py",
    runtime: "python",
    ...overrides,
  };

  return { toolsDir, manifest };
}

/** Extract the tool output from between the untrusted content wrapper tags */
function extractToolOutput(raw: string): string {
  const start = raw.indexOf("[TOOL OUTPUT — UNTRUSTED EXTERNAL DATA]\n");
  const end = raw.indexOf("\n[END TOOL OUTPUT]");
  if (start === -1 || end === -1) return raw;
  return raw.slice(start + "[TOOL OUTPUT — UNTRUSTED EXTERNAL DATA]\n".length, end);
}

test("execute returns stdout from a successful handler", async () => {
  const { toolsDir, manifest } = createToolFixture(`
import sys, json
data = json.load(sys.stdin)
print(json.dumps({"result": data["query"]}))
`);

  // The executor resolves tool name with _ to - mapping
  const executor = new ToolExecutor(toolsDir);
  const result = await executor.execute(manifest, { query: "hello" });

  assert.deepEqual(JSON.parse(extractToolOutput(result)), { result: "hello" });
});

test("execute throws on timeout", async () => {
  const { toolsDir, manifest } = createToolFixture(
    `
import time
time.sleep(10)
`,
    { timeout_ms: 200 },
  );

  const executor = new ToolExecutor(toolsDir);

  await assert.rejects(
    executor.execute(manifest, {}),
    { message: "Tool echo_tool timed out after 200ms" },
  );
});

test("execute throws on non-zero exit code with stderr", async () => {
  const { toolsDir, manifest } = createToolFixture(`
import sys
print("something went wrong", file=sys.stderr)
sys.exit(1)
`);

  const executor = new ToolExecutor(toolsDir);

  await assert.rejects(
    executor.execute(manifest, {}),
    (err: Error) => {
      assert.match(err.message, /Tool echo_tool failed with exit code 1/u);
      assert.match(err.message, /something went wrong/u);
      return true;
    },
  );
});

test("execute rate limits calls when max_calls_per_hour is set", async () => {
  const { toolsDir, manifest } = createToolFixture(
    `
import sys, json
data = json.load(sys.stdin)
print(json.dumps({"ok": True}))
`,
    { max_calls_per_hour: 2 },
  );

  const executor = new ToolExecutor(toolsDir);

  // First two calls should succeed
  await executor.execute(manifest, {});
  await executor.execute(manifest, {});

  // Third call should be rate limited
  await assert.rejects(
    executor.execute(manifest, {}),
    (err: Error) => {
      assert.match(err.message, /Rate limit exceeded for echo_tool/u);
      assert.match(err.message, /2 calls\/hour/u);
      return true;
    },
  );
});

test("execute allows calls when rate limit is not set", async () => {
  const { toolsDir, manifest } = createToolFixture(`
import sys, json
data = json.load(sys.stdin)
print(json.dumps({"ok": True}))
`);

  const executor = new ToolExecutor(toolsDir);

  // Should be able to call many times without rate limiting
  for (let i = 0; i < 5; i++) {
    const result = await executor.execute(manifest, {});
    assert.deepEqual(JSON.parse(extractToolOutput(result)), { ok: true });
  }
});

test("execute validates output schema without crashing", async () => {
  const { toolsDir, manifest } = createToolFixture(
    `
import sys, json
data = json.load(sys.stdin)
print(json.dumps({"status": "ok", "id": "123"}))
`,
    {
      output_schema: {
        type: "object",
        required: ["status", "id"],
      },
    },
  );

  const executor = new ToolExecutor(toolsDir);
  const result = await executor.execute(manifest, {});

  // Should complete without errors — output matches schema
  const parsed = JSON.parse(extractToolOutput(result));
  assert.equal(parsed.status, "ok");
  assert.equal(parsed.id, "123");
});

test("execute injects only declared secrets into the subprocess env", async () => {
  // Set test env vars
  process.env.TEST_SECRET_A = "alpha";
  process.env.TEST_SECRET_B = "bravo";
  process.env.TEST_SECRET_C = "charlie";

  const { toolsDir, manifest } = createToolFixture(
    `
import os, json
env_keys = sorted(k for k in os.environ.keys() if k.startswith("TEST_SECRET"))
print(json.dumps(env_keys))
`,
    { secrets: ["TEST_SECRET_A", "TEST_SECRET_B"] },
  );

  const executor = new ToolExecutor(toolsDir);
  const result = await executor.execute(manifest, {});
  const keys = JSON.parse(extractToolOutput(result)) as string[];

  assert.deepEqual(keys, ["TEST_SECRET_A", "TEST_SECRET_B"]);

  // Cleanup
  delete process.env.TEST_SECRET_A;
  delete process.env.TEST_SECRET_B;
  delete process.env.TEST_SECRET_C;
});

test("execute injects trusted persona context without exposing ambient env", async () => {
  process.env.UNRELATED_PERSONA_PATH = "/should/not/leak";
  const personaDir = mkdtempSync(path.join(tmpdir(), "newsteam-persona-context-"));
  const { toolsDir, manifest } = createToolFixture(`
import os, json
print(json.dumps({
    "persona_dir": os.environ.get("NEWSTEAM_PERSONA_DIR"),
    "unrelated": os.environ.get("UNRELATED_PERSONA_PATH"),
}))
`);

  const executor = new ToolExecutor(toolsDir);
  const result = await executor.execute(
    manifest,
    {},
    undefined,
    { agentId: "test-agent", personaDir },
  );
  const parsed = JSON.parse(extractToolOutput(result)) as Record<string, unknown>;

  assert.equal(parsed.persona_dir, path.resolve(personaDir));
  assert.equal(parsed.unrelated, null);
  delete process.env.UNRELATED_PERSONA_PATH;
});

test("feed_manage reads the invoking agent's persona feed registry", async () => {
  const personaDir = mkdtempSync(path.join(tmpdir(), "newsteam-feed-tool-persona-"));
  writeFileSync(path.join(personaDir, "feeds.json"), JSON.stringify([{
    id: "agent-specific-feed",
    name: "Agent Specific Feed",
    type: "rss",
    url: "https://example.com/feed.xml",
  }]), "utf8");

  const manifest = JSON.parse(
    readFileSync(path.resolve("tools/feed-manage/manifest.json"), "utf8"),
  ) as ToolManifest;
  const executor = new ToolExecutor(path.resolve("tools"));
  const result = await executor.execute(
    manifest,
    { action: "list" },
    undefined,
    { agentId: "scoped-agent", personaDir },
  );
  const parsed = JSON.parse(extractToolOutput(result)) as {
    feeds: Array<{ id: string }>;
  };

  assert.deepEqual(parsed.feeds.map((feed) => feed.id), ["agent-specific-feed"]);
});

test("recall searches the invoking agent's memory file", async () => {
  const personaDir = mkdtempSync(path.join(tmpdir(), "newsteam-recall-persona-"));
  writeFileSync(path.join(personaDir, "MEMORY.md"), [
    "## preference",
    "- Favorite market is Tokyo.",
    "## fact",
    "- Reads monetary policy releases.",
  ].join("\n"), "utf8");

  const manifest = JSON.parse(
    readFileSync(path.resolve("tools/recall/manifest.json"), "utf8"),
  ) as ToolManifest;
  const executor = new ToolExecutor(path.resolve("tools"));
  const result = await executor.execute(
    manifest,
    { query: "TOKYO" },
    undefined,
    { agentId: "scoped-agent", personaDir },
  );
  const parsed = JSON.parse(extractToolOutput(result)) as {
    matches: string[];
    count: number;
  };

  assert.deepEqual(parsed.matches, ["Favorite market is Tokyo."]);
  assert.equal(parsed.count, 1);
});

test("recall fails closed without trusted persona context", async () => {
  const manifest = JSON.parse(
    readFileSync(path.resolve("tools/recall/manifest.json"), "utf8"),
  ) as ToolManifest;
  const executor = new ToolExecutor(path.resolve("tools"));
  const result = await executor.execute(manifest, { query: "Tokyo" });
  const parsed = JSON.parse(extractToolOutput(result)) as {
    error: string;
    matches: string[];
  };

  assert.equal(parsed.error, "missing_tool_context");
  assert.deepEqual(parsed.matches, []);
});
