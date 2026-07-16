import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createDemoWorkspace,
  formatDemoError,
  loadDemoFallbackItems,
} from "../src/demo-support.ts";

test("createDemoWorkspace copies the public persona and cleans up runtime state", () => {
  const workspace = createDemoWorkspace(process.cwd(), tmpdir());
  try {
    assert.ok(existsSync(path.join(workspace.personaDir, "IDENTITY.md")));
    assert.ok(existsSync(path.join(workspace.personaDir, "feeds.json")));

    writeFileSync(path.join(workspace.personaDir, "feeds_state.json"), "{}", "utf8");
    assert.ok(existsSync(path.join(workspace.personaDir, "feeds_state.json")));
  } finally {
    workspace.cleanup();
  }

  assert.equal(existsSync(workspace.rootDir), false);
});

test("loadDemoFallbackItems returns source-linked bundled items", () => {
  const items = loadDemoFallbackItems(process.cwd());

  assert.ok(items.length >= 3);
  for (const item of items) {
    assert.ok(item.feed_id);
    assert.ok(item.title);
    assert.match(item.url ?? "", /^https:\/\//u);
    assert.ok(item.snippet);
  }
});

test("formatDemoError gives actionable Google API guidance", () => {
  assert.match(
    formatDemoError(new Error("GOOGLE_API_KEY is required. Get a free key.")),
    /Get a free key/u,
  );
  const dailyQuotaError = new Error(
    "429 RESOURCE_EXHAUSTED quotaId: GenerateRequestsPerDayPerProjectPerModel-FreeTier, limit: 20",
  );
  assert.equal(
    formatDemoError(dailyQuotaError),
    "Gemini's daily 20-request limit was reached. It resets at midnight Pacific Time. API keys from the same Google Cloud project share this quota. Check usage at https://ai.dev/rate-limit.",
  );
  assert.match(
    formatDemoError(new Error("429 quotaId: GenerateRequestsPerMinutePerProject-FreeTier")),
    /Wait a minute/u,
  );
  assert.match(
    formatDemoError(new Error("429 RESOURCE_EXHAUSTED")),
    /https:\/\/ai\.dev\/rate-limit/u,
  );
  assert.match(formatDemoError(new Error("403 API key invalid")), /GOOGLE_API_KEY/u);
  assert.equal(formatDemoError(new Error("Feed parser failed")), "Feed parser failed");
});
