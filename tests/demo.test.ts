import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createDemoWorkspace,
  formatDemoError,
} from "../src/demo-support.ts";

test("createDemoWorkspace copies the public persona and cleans up runtime state", () => {
  const workspace = createDemoWorkspace(process.cwd(), { tempParent: tmpdir() });
  try {
    assert.ok(existsSync(path.join(workspace.personaDir, "IDENTITY.md")));
    assert.ok(existsSync(path.join(workspace.personaDir, "feeds.json")));
    assert.ok(existsSync(path.join(workspace.personaDir, "PROFILE.png")));

    writeFileSync(path.join(workspace.personaDir, "feeds_state.json"), "{}", "utf8");
    assert.ok(existsSync(path.join(workspace.personaDir, "feeds_state.json")));
  } finally {
    workspace.cleanup();
  }

  assert.equal(existsSync(workspace.rootDir), false);
});

test("createDemoWorkspace copies a selected public persona", () => {
  const workspace = createDemoWorkspace(process.cwd(), {
    personaId: "the-analyst",
    tempParent: tmpdir(),
  });
  try {
    const identityPath = path.join(workspace.personaDir, "IDENTITY.md");
    assert.match(readFileSync(identityPath, "utf8"), /\*\*Name:\*\* The Analyst/u);
  } finally {
    workspace.cleanup();
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
  assert.match(formatDemoError(new Error("403 API key invalid")), /enter a different key/u);
  assert.equal(formatDemoError(new Error("Feed parser failed")), "Feed parser failed");
});
