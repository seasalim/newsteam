import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import type http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { startDashboard } from "../src/dashboard.ts";
import { CostLedger } from "../src/ledger.ts";
import { EventLogger } from "../src/logger.ts";

async function listen(server: http.Server): Promise<string> {
  if (!server.listening) await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server address");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test("dashboard status and feed APIs expose profile URLs without persona paths", async (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "newsteam-dashboard-profile-"));
  const personaDir = path.join(rootDir, "persona");
  mkdirSync(personaDir);
  copyFileSync(
    path.join(process.cwd(), "examples", "personas", "the-general", "PROFILE.png"),
    path.join(personaDir, "PROFILE.png"),
  );

  const budgetConfig = {
    model: "google/test-model",
    max_input_tokens: 10_000,
    max_output_tokens: 1_000,
    context_summary_max_tokens: 500,
    max_turns: 4,
    max_session_cost_cents: 10,
    context_strategy: "truncate",
  };
  const feedConfig = {
    enabled: true,
    check_interval_minutes: 60,
    waking_hours_start: 8,
    waking_hours_end: 22,
    channel_id: "agent-feed",
    max_items_per_digest: 10,
  };
  const agent = {
    id: "agent",
    raw: { id: "agent", persona_dir: personaDir, channel_ids: ["agent-chat"], feeds: feedConfig },
    config: { budget: budgetConfig, feeds: feedConfig },
    budget: {
      getStats: () => ({ turns: 0, inputTokens: 0, outputTokens: 0, costCents: 0, toolCalls: 0 }),
    },
  };
  const server = startDashboard({
    swarmConfig: {
      channel: { provider: "discord" },
      defaults: {
        budget: budgetConfig,
        conversation: { window_size: 10, rate_limit_ms: 1_000 },
        memory: { max_tokens: 1_000 },
      },
      tools_dir: "tools",
      confirmation_timeout_ms: 120_000,
      agents: [agent.raw],
    },
    agents: [agent],
    logger: new EventLogger(path.join(rootDir, "logs")),
    ledger: new CostLedger(path.join(rootDir, "ledger")),
    startedAt: new Date(),
  } as never, { host: "127.0.0.1", port: 0 });
  const baseUrl = await listen(server);
  t.after(async () => close(server));

  const statusText = await fetch(`${baseUrl}/api/status`).then((response) => response.text());
  assert.doesNotMatch(statusText, /newsteam-dashboard-profile|persona_dir/u);
  const status = JSON.parse(statusText);
  assert.equal(status.agents[0].profile_image_url, "/api/personas/agent/profile.png");

  const feedsText = await fetch(`${baseUrl}/api/feeds`).then((response) => response.text());
  assert.doesNotMatch(feedsText, /newsteam-dashboard-profile|persona_dir/u);
  const feeds = JSON.parse(feedsText);
  assert.equal(feeds.agents[0].profile_image_url, "/api/personas/agent/profile.png");
  assert.equal((await fetch(`${baseUrl}/api/personas/agent/profile.png`)).status, 200);
});
