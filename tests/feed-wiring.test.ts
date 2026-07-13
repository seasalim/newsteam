import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { getFeedStartupWarning } from "../src/feed-wiring.ts";

test("getFeedStartupWarning reports a missing persona directory", () => {
  const personaDir = path.join(mkdtempSync(path.join(tmpdir(), "feed-startup-")), "missing");

  const warning = getFeedStartupWarning({
    agentId: "test-agent",
    feedsEnabled: true,
    personaDir,
  });

  assert.equal(warning, `test-agent: feeds enabled but persona directory is missing: ${personaDir}`);
});

test("getFeedStartupWarning reports a missing feeds.json", () => {
  const personaDir = mkdtempSync(path.join(tmpdir(), "feed-startup-"));

  const warning = getFeedStartupWarning({
    agentId: "test-agent",
    feedsEnabled: true,
    personaDir,
  });

  assert.equal(warning, `test-agent: feeds enabled but feeds.json is missing: ${path.join(personaDir, "feeds.json")}`);
});

test("getFeedStartupWarning reports a registry with no valid feeds", () => {
  const personaDir = mkdtempSync(path.join(tmpdir(), "feed-startup-"));
  const feedsPath = path.join(personaDir, "feeds.json");
  writeFileSync(feedsPath, "[]", "utf-8");

  const warning = getFeedStartupWarning({
    agentId: "test-agent",
    feedsEnabled: true,
    personaDir,
  });

  assert.equal(warning, `test-agent: feeds enabled but no valid feeds are configured in ${feedsPath}`);
});

test("getFeedStartupWarning accepts a valid feed registry", () => {
  const personaDir = mkdtempSync(path.join(tmpdir(), "feed-startup-"));
  writeFileSync(
    path.join(personaDir, "feeds.json"),
    JSON.stringify([{ id: "example", name: "Example", type: "rss", url: "https://example.com/feed.xml" }]),
    "utf-8",
  );

  assert.equal(getFeedStartupWarning({
    agentId: "test-agent",
    feedsEnabled: true,
    personaDir,
  }), null);
});

test("getFeedStartupWarning ignores feed-disabled agents", () => {
  const personaDir = path.join(mkdtempSync(path.join(tmpdir(), "feed-startup-")), "missing");

  assert.equal(getFeedStartupWarning({
    agentId: "test-agent",
    feedsEnabled: false,
    personaDir,
  }), null);
});
