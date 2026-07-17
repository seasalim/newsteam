import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { loadConfig, resolveAgentConfig } from "../src/config.ts";

function writeTempConfig(contents: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), "newsteam-config-test-"));
  const filePath = path.join(directory, "config.yaml");
  writeFileSync(filePath, contents, "utf8");
  return filePath;
}

/** Minimal valid swarm config for tests. */
const MINIMAL_SWARM = `
defaults:
  budget:
    model: anthropic/claude-haiku-4-5
    max_input_tokens: 8000
    max_output_tokens: 2000
    max_turns: 5
    max_session_cost_cents: 50
    context_strategy: truncate
  conversation:
    window_size: 10
    rate_limit_ms: 1000
  memory:
    max_tokens: 1500
discord:
  allowed_user_id: "123"
tools_dir: tools
agents:
  - id: test-agent
    persona_dir: persona/test
    channel_ids:
      - "456"
`;

test("loadConfig loads the example config (swarm format)", () => {
  const config = loadConfig("config.example.yaml");

  assert.equal(config.defaults.budget.model, "google/gemini-3-flash-preview");
  assert.equal(config.defaults.budget.digest_thinking_level, "low");
  assert.equal(config.defaults.budget.max_input_tokens, 20000);
  assert.equal(config.defaults.budget.max_output_tokens, 6000);
  assert.equal(config.defaults.budget.context_summary_max_tokens, 500);
  assert.equal(config.defaults.budget.max_turns, 12);
  assert.equal(config.channel.provider, "local");
  assert.equal(config.discord, undefined);
  assert.equal(config.defaults.conversation.window_size, 10);
  assert.equal(config.tools_dir, "tools");
  assert.equal(config.defaults.memory.max_tokens, 3000);
  assert.ok(Array.isArray(config.agents));
  assert.ok(config.agents.length > 0);
  assert.equal(config.agents[0]!.id, "kingclawd");
  assert.deepEqual(config.agents[0]!.channel_ids, ["kingclawd-chat"]);
  assert.equal(config.agents[0]!.feeds?.channel_id, "kingclawd-feed");
});

test("channel provider defaults to Discord and still requires Discord config", () => {
  const configPath = writeTempConfig(MINIMAL_SWARM.replace(
    /discord:\n  allowed_user_id: "123"\n/u,
    "",
  ));

  assert.throws(() => loadConfig(configPath), {
    message: "config.discord is required and must be an object",
  });
});

test("local channel provider does not require Discord config", () => {
  const configPath = writeTempConfig(
    MINIMAL_SWARM
      .replace(
        /discord:\n  allowed_user_id: "123"\n/u,
        "channel:\n  provider: local\n",
      )
      .replace('      - "456"', "      - test-agent-chat"),
  );

  const config = loadConfig(configPath);
  assert.equal(config.channel.provider, "local");
  assert.equal(config.discord, undefined);
  const resolved = resolveAgentConfig(config.agents[0]!, config);
  assert.equal(resolved.discord.allowed_user_id, undefined);
  assert.deepEqual(resolved.discord.allowed_channel_ids, ["test-agent-chat"]);
});

test("channel provider rejects unknown values", () => {
  const configPath = writeTempConfig(`channel:\n  provider: carrier-pigeon\n${MINIMAL_SWARM}`);
  assert.throws(() => loadConfig(configPath), {
    message: "config.channel.provider must be one of: discord, local",
  });
});

test("loadConfig gives setup guidance when config.yaml is missing", () => {
  const missingPath = path.join(tmpdir(), "newsteam-missing-config.yaml");

  assert.throws(() => loadConfig(missingPath), {
    message: /cp config\.example\.yaml config\.yaml/u,
  });
});

test("loadConfig with legacy flat format auto-converts to swarm format", () => {
  const configPath = writeTempConfig(`
budget:
  model: anthropic/claude-haiku-4-5
  max_input_tokens: 8000
  max_output_tokens: 2000
  max_turns: 5
  max_session_cost_cents: 50
  context_strategy: truncate
discord:
  allowed_user_id: "123"
  allowed_channel_ids:
    - "456"
conversation:
  window_size: 10
  rate_limit_ms: 1000
persona_dir: persona
tools_dir: tools
memory:
  max_tokens: 1500
`);

  const config = loadConfig(configPath);
  assert.equal(config.agents.length, 1);
  assert.equal(config.agents[0]!.id, "default");
  assert.deepEqual(config.agents[0]!.channel_ids, ["456"]);
  assert.equal(config.agents[0]!.persona_dir, "persona");
  assert.equal(config.defaults.budget.model, "anthropic/claude-haiku-4-5");
  assert.equal(config.defaults.budget.context_summary_max_tokens, 500);
});

test("loadConfig throws a clear error when a required field is missing", () => {
  const configPath = writeTempConfig(`
defaults:
  budget:
    model: anthropic/claude-haiku-4-5
    max_input_tokens: 8000
    max_output_tokens: 2000
    max_session_cost_cents: 50
    context_strategy: truncate
  conversation:
    window_size: 10
    rate_limit_ms: 1000
  memory:
    max_tokens: 1500
discord:
  allowed_user_id: "123"
tools_dir: tools
agents:
  - id: test
    persona_dir: persona
    channel_ids:
      - "456"
`);

  assert.throws(() => loadConfig(configPath), {
    message:
      "config.defaults.budget.max_turns is required and must be a positive integer",
  });
});

test("loadConfig throws a clear error when a field has the wrong type", () => {
  const configPath = writeTempConfig(`
defaults:
  budget:
    model: anthropic/claude-haiku-4-5
    max_input_tokens: 8000
    max_output_tokens: "2000"
    max_turns: 5
    max_session_cost_cents: 50
    context_strategy: truncate
  conversation:
    window_size: 10
    rate_limit_ms: 1000
  memory:
    max_tokens: 1500
discord:
  allowed_user_id: "123"
tools_dir: tools
agents:
  - id: test
    persona_dir: persona
    channel_ids:
      - "456"
`);

  assert.throws(() => loadConfig(configPath), {
    message:
      "config.defaults.budget.max_output_tokens is required and must be a positive integer",
  });
});

test("loadConfig parses optional monthly_budget_cents when present", () => {
  const configPath = writeTempConfig(`
defaults:
  budget:
    model: anthropic/claude-haiku-4-5
    max_input_tokens: 8000
    max_output_tokens: 2000
    max_turns: 5
    max_session_cost_cents: 50
    context_strategy: truncate
    monthly_budget_cents: 500
  conversation:
    window_size: 10
    rate_limit_ms: 1000
  memory:
    max_tokens: 1500
discord:
  allowed_user_id: "123"
tools_dir: tools
agents:
  - id: test
    persona_dir: persona
    channel_ids:
      - "456"
`);

  const config = loadConfig(configPath);
  assert.equal(config.defaults.budget.monthly_budget_cents, 500);
});

test("loadConfig allows missing monthly_budget_cents", () => {
  const configPath = writeTempConfig(MINIMAL_SWARM);
  const config = loadConfig(configPath);
  assert.equal(config.defaults.budget.monthly_budget_cents, undefined);
});

test("loadConfig parses optional thinking levels when present", () => {
  const configPath = writeTempConfig(`
defaults:
  budget:
    model: google/gemini-3-flash-preview
    digest_model: google/gemini-3.1-pro-preview
    thinking_level: medium
    digest_thinking_level: low
    max_input_tokens: 8000
    max_output_tokens: 2000
    max_turns: 5
    max_session_cost_cents: 50
    context_strategy: truncate
  conversation:
    window_size: 10
    rate_limit_ms: 1000
  memory:
    max_tokens: 1500
discord:
  allowed_user_id: "123"
tools_dir: tools
agents:
  - id: test
    persona_dir: persona
    channel_ids:
      - "456"
`);

  const config = loadConfig(configPath);
  assert.equal(config.defaults.budget.thinking_level, "medium");
  assert.equal(config.defaults.budget.digest_thinking_level, "low");
});

test("loadConfig rejects invalid thinking levels", () => {
  const configPath = writeTempConfig(`
defaults:
  budget:
    model: google/gemini-3-flash-preview
    thinking_level: turbo
    max_input_tokens: 8000
    max_output_tokens: 2000
    max_turns: 5
    max_session_cost_cents: 50
    context_strategy: truncate
  conversation:
    window_size: 10
    rate_limit_ms: 1000
  memory:
    max_tokens: 1500
discord:
  allowed_user_id: "123"
tools_dir: tools
agents:
  - id: test
    persona_dir: persona
    channel_ids:
      - "456"
`);

  assert.throws(() => loadConfig(configPath), {
    message: "config.defaults.budget.thinking_level must be one of: minimal, low, medium, high",
  });
});

test("loadConfig parses optional idle_timeout_minutes when present", () => {
  const configPath = writeTempConfig(`
defaults:
  budget:
    model: anthropic/claude-haiku-4-5
    max_input_tokens: 8000
    max_output_tokens: 2000
    max_turns: 5
    max_session_cost_cents: 50
    context_strategy: truncate
  conversation:
    window_size: 10
    rate_limit_ms: 1000
    idle_timeout_minutes: 30
  memory:
    max_tokens: 1500
discord:
  allowed_user_id: "123"
tools_dir: tools
agents:
  - id: test
    persona_dir: persona
    channel_ids:
      - "456"
`);

  const config = loadConfig(configPath);
  assert.equal(config.defaults.conversation.idle_timeout_minutes, 30);
});

test("loadConfig allows missing idle_timeout_minutes", () => {
  const configPath = writeTempConfig(MINIMAL_SWARM);
  const config = loadConfig(configPath);
  assert.equal(config.defaults.conversation.idle_timeout_minutes, undefined);
});

test("loadConfig rejects non-string channel IDs in agents", () => {
  const configPath = writeTempConfig(`
defaults:
  budget:
    model: anthropic/claude-haiku-4-5
    max_input_tokens: 8000
    max_output_tokens: 2000
    max_turns: 5
    max_session_cost_cents: 50
    context_strategy: truncate
  conversation:
    window_size: 10
    rate_limit_ms: 1000
  memory:
    max_tokens: 1500
discord:
  allowed_user_id: "123"
tools_dir: tools
agents:
  - id: test
    persona_dir: persona
    channel_ids:
      - "456"
      - 789
`);

  assert.throws(() => loadConfig(configPath), {
    message:
      "config.agents[0].channel_ids is required and must be an array of strings",
  });
});

test("loadConfig validates the optional feeds section on an agent", () => {
  const configPath = writeTempConfig(`
defaults:
  budget:
    model: anthropic/claude-haiku-4-5
    max_input_tokens: 8000
    max_output_tokens: 2000
    max_turns: 5
    max_session_cost_cents: 50
    context_strategy: truncate
  conversation:
    window_size: 10
    rate_limit_ms: 1000
  memory:
    max_tokens: 1500
discord:
  allowed_user_id: "123"
tools_dir: tools
agents:
  - id: test
    persona_dir: persona
    channel_ids:
      - "456"
    feeds:
      enabled: true
      check_interval_minutes: 15
      waking_hours_start: 8
      waking_hours_end: 23
      channel_id: "789"
      max_items_per_digest: 5
`);

  const config = loadConfig(configPath);
  assert.deepEqual(config.agents[0]!.feeds, {
    enabled: true,
    check_interval_minutes: 15,
    waking_hours_start: 8,
    waking_hours_end: 23,
    channel_id: "789",
    max_items_per_digest: 5,
    max_queue_age_hours: undefined,
    max_content_age_hours: undefined,
    digest_times: undefined,
    digest_max_turns: undefined,
    synthesis_day: undefined,
    synthesis_time: undefined,
  });
});

test("loadConfig rejects invalid feeds config values", () => {
  const configPath = writeTempConfig(`
defaults:
  budget:
    model: anthropic/claude-haiku-4-5
    max_input_tokens: 8000
    max_output_tokens: 2000
    max_turns: 5
    max_session_cost_cents: 50
    context_strategy: truncate
  conversation:
    window_size: 10
    rate_limit_ms: 1000
  memory:
    max_tokens: 1500
discord:
  allowed_user_id: "123"
tools_dir: tools
agents:
  - id: test
    persona_dir: persona
    channel_ids:
      - "456"
    feeds:
      enabled: true
      check_interval_minutes: 15
      waking_hours_start: 8
      waking_hours_end: 24
      channel_id: "789"
      max_items_per_digest: 5
`);

  assert.throws(() => loadConfig(configPath), {
    message:
      "config.agents[0].feeds.waking_hours_end is required and must be an integer between 0 and 23",
  });
});

test("loadConfig accepts feeds with digest_times", () => {
  const configPath = writeTempConfig(`
defaults:
  budget:
    model: anthropic/claude-haiku-4-5
    max_input_tokens: 8000
    max_output_tokens: 2000
    max_turns: 5
    max_session_cost_cents: 50
    context_strategy: truncate
  conversation:
    window_size: 10
    rate_limit_ms: 1000
  memory:
    max_tokens: 1500
discord:
  allowed_user_id: "123"
tools_dir: tools
agents:
  - id: test
    persona_dir: persona
    channel_ids:
      - "456"
    feeds:
      enabled: true
      check_interval_minutes: 15
      waking_hours_start: 8
      waking_hours_end: 23
      channel_id: "789"
      max_items_per_digest: 5
      digest_times:
        - "09:00"
        - "13:00"
        - "18:00"
`);

  const config = loadConfig(configPath);
  assert.deepEqual(config.agents[0]!.feeds?.digest_times, ["09:00", "13:00", "18:00"]);
});

test("loadConfig warns when two agents share a digest time", (t) => {
  const warnings: string[] = [];
  const warnMock = t.mock.method(console, "warn", (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  });

  const configPath = writeTempConfig(`
defaults:
  budget:
    model: anthropic/claude-haiku-4-5
    max_input_tokens: 8000
    max_output_tokens: 2000
    max_turns: 5
    max_session_cost_cents: 50
    context_strategy: truncate
  conversation:
    window_size: 10
    rate_limit_ms: 1000
  memory:
    max_tokens: 1500
discord:
  allowed_user_id: "123"
tools_dir: tools
agents:
  - id: first
    persona_dir: persona/first
    channel_ids:
      - "456"
    feeds:
      enabled: true
      check_interval_minutes: 15
      waking_hours_start: 8
      waking_hours_end: 23
      channel_id: "789"
      max_items_per_digest: 5
      digest_times:
        - "08:00"
        - "13:00"
  - id: second
    persona_dir: persona/second
    channel_ids:
      - "457"
    feeds:
      enabled: true
      check_interval_minutes: 15
      waking_hours_start: 8
      waking_hours_end: 23
      channel_id: "790"
      max_items_per_digest: 5
      digest_times:
        - "08:30"
        - "13:00"
`);

  loadConfig(configPath);
  warnMock.mock.restore();

  const collisionWarnings = warnings.filter((w) => w.includes("digest time"));
  assert.equal(collisionWarnings.length, 1, "exactly one shared digest time should warn");
  assert.ok(collisionWarnings[0]!.includes('"13:00"'), "warning should name the shared time");
  assert.ok(collisionWarnings[0]!.includes("first"), "warning should name the first agent");
  assert.ok(collisionWarnings[0]!.includes("second"), "warning should name the second agent");
});

test("loadConfig accepts feeds with pending_max_age_hours as alias for max_queue_age_hours", () => {
  const configPath = writeTempConfig(`
defaults:
  budget:
    model: anthropic/claude-haiku-4-5
    max_input_tokens: 8000
    max_output_tokens: 2000
    max_turns: 5
    max_session_cost_cents: 50
    context_strategy: truncate
  conversation:
    window_size: 10
    rate_limit_ms: 1000
  memory:
    max_tokens: 1500
discord:
  allowed_user_id: "123"
tools_dir: tools
agents:
  - id: test
    persona_dir: persona
    channel_ids:
      - "456"
    feeds:
      enabled: true
      check_interval_minutes: 15
      waking_hours_start: 8
      waking_hours_end: 23
      channel_id: "789"
      max_items_per_digest: 5
      pending_max_age_hours: 12
`);

  const config = loadConfig(configPath);
  assert.equal(config.agents[0]!.feeds?.max_queue_age_hours, 12);
  assert.equal(config.agents[0]!.feeds?.max_content_age_hours, undefined);
});

test("loadConfig accepts feeds with max_queue_age_hours and max_content_age_hours", () => {
  const configPath = writeTempConfig(`
defaults:
  budget:
    model: anthropic/claude-haiku-4-5
    max_input_tokens: 8000
    max_output_tokens: 2000
    max_turns: 5
    max_session_cost_cents: 50
    context_strategy: truncate
  conversation:
    window_size: 10
    rate_limit_ms: 1000
  memory:
    max_tokens: 1500
discord:
  allowed_user_id: "123"
tools_dir: tools
agents:
  - id: test
    persona_dir: persona
    channel_ids:
      - "456"
    feeds:
      enabled: true
      check_interval_minutes: 15
      waking_hours_start: 8
      waking_hours_end: 23
      channel_id: "789"
      max_items_per_digest: 5
      max_queue_age_hours: 18
      max_content_age_hours: 72
`);

  const config = loadConfig(configPath);
  assert.equal(config.agents[0]!.feeds?.max_queue_age_hours, 18);
  assert.equal(config.agents[0]!.feeds?.max_content_age_hours, 72);
});

test("loadConfig rejects invalid time format in digest_times", () => {
  const invalidTimes = ["25:00", "9:00", "abc"];

  for (const badTime of invalidTimes) {
    const configPath = writeTempConfig(`
defaults:
  budget:
    model: anthropic/claude-haiku-4-5
    max_input_tokens: 8000
    max_output_tokens: 2000
    max_turns: 5
    max_session_cost_cents: 50
    context_strategy: truncate
  conversation:
    window_size: 10
    rate_limit_ms: 1000
  memory:
    max_tokens: 1500
discord:
  allowed_user_id: "123"
tools_dir: tools
agents:
  - id: test
    persona_dir: persona
    channel_ids:
      - "456"
    feeds:
      enabled: true
      check_interval_minutes: 15
      waking_hours_start: 8
      waking_hours_end: 23
      channel_id: "789"
      max_items_per_digest: 5
      digest_times:
        - "${badTime}"
`);

    assert.throws(() => loadConfig(configPath), {
      message: `config.agents[0].feeds.digest_times contains invalid time "${badTime}"; expected HH:MM in 24h format`,
    });
  }
});

test("loadConfig accepts agent without feeds (feeds undefined)", () => {
  const configPath = writeTempConfig(MINIMAL_SWARM);
  const config = loadConfig(configPath);
  assert.equal(config.agents[0]!.feeds, undefined);
});

test("loadConfig parses optional confirmation_timeout_ms when present", () => {
  const configPath = writeTempConfig(`
defaults:
  budget:
    model: anthropic/claude-haiku-4-5
    max_input_tokens: 8000
    max_output_tokens: 2000
    max_turns: 5
    max_session_cost_cents: 50
    context_strategy: truncate
  conversation:
    window_size: 10
    rate_limit_ms: 1000
  memory:
    max_tokens: 1500
discord:
  allowed_user_id: "123"
tools_dir: tools
confirmation_timeout_ms: 60000
agents:
  - id: test
    persona_dir: persona
    channel_ids:
      - "456"
`);

  const config = loadConfig(configPath);
  assert.equal(config.confirmation_timeout_ms, 60000);
});

test("loadConfig defaults confirmation_timeout_ms to 120000 when missing", () => {
  const configPath = writeTempConfig(MINIMAL_SWARM);
  const config = loadConfig(configPath);
  assert.equal(config.confirmation_timeout_ms, 120000);
});

// --- context_strategy validation tests ---

test("context_strategy rejects invalid values", () => {
  const configPath = writeTempConfig(`
defaults:
  budget:
    model: anthropic/claude-haiku-4-5
    max_input_tokens: 8000
    max_output_tokens: 2000
    max_turns: 5
    max_session_cost_cents: 50
    context_strategy: invalid_strategy
  conversation:
    window_size: 10
    rate_limit_ms: 1000
  memory:
    max_tokens: 1500
discord:
  allowed_user_id: "123"
tools_dir: tools
agents:
  - id: test
    persona_dir: persona
    channel_ids:
      - "456"
`);

  assert.throws(() => loadConfig(configPath), {
    message: "config.defaults.budget.context_strategy must be one of: truncate, summarize",
  });
});

test("context_strategy accepts summarize", () => {
  const configPath = writeTempConfig(`
defaults:
  budget:
    model: anthropic/claude-haiku-4-5
    max_input_tokens: 8000
    max_output_tokens: 2000
    context_summary_max_tokens: 320
    max_turns: 5
    max_session_cost_cents: 50
    context_strategy: summarize
  conversation:
    window_size: 10
    rate_limit_ms: 1000
  memory:
    max_tokens: 1500
discord:
  allowed_user_id: "123"
tools_dir: tools
agents:
  - id: test
    persona_dir: persona
    channel_ids:
      - "456"
`);

  const config = loadConfig(configPath);
  assert.equal(config.defaults.budget.context_strategy, "summarize");
  assert.equal(config.defaults.budget.context_summary_max_tokens, 320);
});

test("context_summary_max_tokens defaults to the lower output limit", () => {
  const configPath = writeTempConfig(MINIMAL_SWARM.replace(
    "max_output_tokens: 2000",
    "max_output_tokens: 200",
  ));

  const config = loadConfig(configPath);
  assert.equal(config.defaults.budget.context_summary_max_tokens, 200);
});

test("context_summary_max_tokens cannot exceed max_output_tokens", () => {
  const configPath = writeTempConfig(MINIMAL_SWARM.replace(
    "max_output_tokens: 2000",
    "max_output_tokens: 2000\n    context_summary_max_tokens: 2001",
  ));

  assert.throws(() => loadConfig(configPath), {
    message: "config.defaults.budget.context_summary_max_tokens must be less than or equal to config.defaults.budget.max_output_tokens",
  });
});

test("per-agent output overrides clamp the inherited summary limit", () => {
  const swarm = loadConfig(writeTempConfig(MINIMAL_SWARM.replace(
    "channel_ids:\n      - \"456\"",
    "channel_ids:\n      - \"456\"\n    budget:\n      max_output_tokens: 300",
  )));

  const resolved = resolveAgentConfig(swarm.agents[0]!, swarm);
  assert.equal(resolved.budget.max_output_tokens, 300);
  assert.equal(resolved.budget.context_summary_max_tokens, 300);
});

// --- channel_personas tests ---

test("channel_personas validates object with string values on agent", () => {
  const configPath = writeTempConfig(`
defaults:
  budget:
    model: anthropic/claude-haiku-4-5
    max_input_tokens: 8000
    max_output_tokens: 2000
    max_turns: 5
    max_session_cost_cents: 50
    context_strategy: truncate
  conversation:
    window_size: 10
    rate_limit_ms: 1000
  memory:
    max_tokens: 1500
discord:
  allowed_user_id: "123"
tools_dir: tools
agents:
  - id: test
    persona_dir: persona
    channel_ids:
      - "456"
    channel_personas:
      "456": "chill-mode.md"
      "789": "serious-mode.md"
`);

  const config = loadConfig(configPath);

  assert.deepEqual(config.agents[0]!.channel_personas, {
    "456": "chill-mode.md",
    "789": "serious-mode.md",
  });
});

test("channel_personas is undefined when not specified on agent", () => {
  const configPath = writeTempConfig(MINIMAL_SWARM);
  const config = loadConfig(configPath);
  assert.equal(config.agents[0]!.channel_personas, undefined);
});

test("channel_personas rejects non-string values", () => {
  const configPath = writeTempConfig(`
defaults:
  budget:
    model: anthropic/claude-haiku-4-5
    max_input_tokens: 8000
    max_output_tokens: 2000
    max_turns: 5
    max_session_cost_cents: 50
    context_strategy: truncate
  conversation:
    window_size: 10
    rate_limit_ms: 1000
  memory:
    max_tokens: 1500
discord:
  allowed_user_id: "123"
tools_dir: tools
agents:
  - id: test
    persona_dir: persona
    channel_ids:
      - "456"
    channel_personas:
      "456": 123
`);

  assert.throws(() => loadConfig(configPath), {
    message: "config.agents[0].channel_personas.456 must be a string (filename)",
  });
});

// --- Swarm-specific validation tests ---

test("loadConfig rejects duplicate agent IDs", () => {
  const configPath = writeTempConfig(`
defaults:
  budget:
    model: anthropic/claude-haiku-4-5
    max_input_tokens: 8000
    max_output_tokens: 2000
    max_turns: 5
    max_session_cost_cents: 50
    context_strategy: truncate
  conversation:
    window_size: 10
    rate_limit_ms: 1000
  memory:
    max_tokens: 1500
discord:
  allowed_user_id: "123"
tools_dir: tools
agents:
  - id: agent-a
    persona_dir: persona/a
    channel_ids:
      - "111"
  - id: agent-a
    persona_dir: persona/b
    channel_ids:
      - "222"
`);

  assert.throws(() => loadConfig(configPath), {
    message: 'Duplicate agent id: "agent-a"',
  });
});

test("loadConfig rejects overlapping channel IDs", () => {
  const configPath = writeTempConfig(`
defaults:
  budget:
    model: anthropic/claude-haiku-4-5
    max_input_tokens: 8000
    max_output_tokens: 2000
    max_turns: 5
    max_session_cost_cents: 50
    context_strategy: truncate
  conversation:
    window_size: 10
    rate_limit_ms: 1000
  memory:
    max_tokens: 1500
discord:
  allowed_user_id: "123"
tools_dir: tools
agents:
  - id: agent-a
    persona_dir: persona/a
    channel_ids:
      - "111"
      - "222"
  - id: agent-b
    persona_dir: persona/b
    channel_ids:
      - "222"
      - "333"
`);

  assert.throws(() => loadConfig(configPath), {
    message: 'Channel "222" is assigned to both agents "agent-a" and "agent-b"',
  });
});

test("loadConfig rejects feed channel overlap across agents", () => {
  const configPath = writeTempConfig(`
defaults:
  budget:
    model: anthropic/claude-haiku-4-5
    max_input_tokens: 8000
    max_output_tokens: 2000
    max_turns: 5
    max_session_cost_cents: 50
    context_strategy: truncate
  conversation:
    window_size: 10
    rate_limit_ms: 1000
  memory:
    max_tokens: 1500
channel:
  provider: local
tools_dir: tools
agents:
  - id: agent-a
    persona_dir: persona/a
    channel_ids: [a-chat]
    feeds:
      enabled: true
      check_interval_minutes: 15
      waking_hours_start: 7
      waking_hours_end: 22
      channel_id: shared-feed
      max_items_per_digest: 10
  - id: agent-b
    persona_dir: persona/b
    channel_ids: [shared-feed]
`);

  assert.throws(() => loadConfig(configPath), {
    message: 'Channel "shared-feed" is assigned to both agents "agent-a" and "agent-b"',
  });
});

test("loadConfig rejects empty agents array", () => {
  const configPath = writeTempConfig(`
defaults:
  budget:
    model: anthropic/claude-haiku-4-5
    max_input_tokens: 8000
    max_output_tokens: 2000
    max_turns: 5
    max_session_cost_cents: 50
    context_strategy: truncate
  conversation:
    window_size: 10
    rate_limit_ms: 1000
  memory:
    max_tokens: 1500
discord:
  allowed_user_id: "123"
tools_dir: tools
agents: []
`);

  assert.throws(() => loadConfig(configPath), {
    message: "config.agents is required and must be a non-empty array",
  });
});

test("resolveAgentConfig uses global defaults for all agents", () => {
  const configPath = writeTempConfig(`
defaults:
  budget:
    model: anthropic/claude-haiku-4-5
    max_input_tokens: 8000
    max_output_tokens: 2000
    max_turns: 5
    max_session_cost_cents: 50
    context_strategy: truncate
  conversation:
    window_size: 10
    rate_limit_ms: 1000
  memory:
    max_tokens: 1500
discord:
  allowed_user_id: "123"
tools_dir: tools
agents:
  - id: custom-agent
    persona_dir: persona/custom
    channel_ids:
      - "456"
`);

  const swarm = loadConfig(configPath);
  const resolved = resolveAgentConfig(swarm.agents[0]!, swarm);

  // All budget/conversation/memory come from global defaults
  assert.equal(resolved.budget.model, "anthropic/claude-haiku-4-5");
  assert.equal(resolved.budget.max_session_cost_cents, 50);
  assert.equal(resolved.budget.max_input_tokens, 8000);
  assert.equal(resolved.budget.max_turns, 5);
  assert.equal(resolved.memory.max_tokens, 1500);
  assert.equal(resolved.conversation.window_size, 10);

  // Agent-specific fields
  assert.equal(resolved.persona_dir, "persona/custom");
  assert.deepEqual(resolved.discord.allowed_channel_ids, ["456"]);
  assert.equal(resolved.discord.allowed_user_id, "123");
  assert.equal(resolved.tools_dir, "tools");
});

test("resolveAgentConfig merges per-agent budget overrides onto defaults", () => {
  const configPath = writeTempConfig(`
defaults:
  budget:
    model: anthropic/claude-haiku-4-5
    digest_model: anthropic/claude-sonnet-4-6
    max_input_tokens: 8000
    max_output_tokens: 2000
    max_turns: 5
    max_session_cost_cents: 50
    context_strategy: truncate
  conversation:
    window_size: 10
    rate_limit_ms: 1000
  memory:
    max_tokens: 1500
discord:
  allowed_user_id: "123"
tools_dir: tools
agents:
  - id: custom-agent
    persona_dir: persona/custom
    channel_ids:
      - "456"
    budget:
      model: google/gemini-3-flash
      digest_model: google/gemini-3-flash
      context_summary_max_tokens: 240
      max_turns: 7
`);

  const swarm = loadConfig(configPath);
  const resolved = resolveAgentConfig(swarm.agents[0]!, swarm);

  assert.equal(resolved.budget.model, "google/gemini-3-flash");
  assert.equal(resolved.budget.digest_model, "google/gemini-3-flash");
  assert.equal(resolved.budget.max_turns, 7);
  assert.equal(resolved.budget.max_input_tokens, 8000);
  assert.equal(resolved.budget.context_summary_max_tokens, 240);
  assert.equal(resolved.budget.context_strategy, "truncate");
});

test("loadConfig validates per-agent budget overrides as partial objects", () => {
  const configPath = writeTempConfig(`
defaults:
  budget:
    model: anthropic/claude-haiku-4-5
    max_input_tokens: 8000
    max_output_tokens: 2000
    max_turns: 5
    max_session_cost_cents: 50
    context_strategy: truncate
  conversation:
    window_size: 10
    rate_limit_ms: 1000
  memory:
    max_tokens: 1500
discord:
  allowed_user_id: "123"
tools_dir: tools
agents:
  - id: custom-agent
    persona_dir: persona/custom
    channel_ids:
      - "456"
    budget:
      max_turns: 7
`);

  const swarm = loadConfig(configPath);

  assert.deepEqual(swarm.agents[0]!.budget, {
    max_turns: 7,
  });
});

test("loadConfig rejects invalid per-agent budget override field types", () => {
  const configPath = writeTempConfig(`
defaults:
  budget:
    model: anthropic/claude-haiku-4-5
    max_input_tokens: 8000
    max_output_tokens: 2000
    max_turns: 5
    max_session_cost_cents: 50
    context_strategy: truncate
  conversation:
    window_size: 10
    rate_limit_ms: 1000
  memory:
    max_tokens: 1500
discord:
  allowed_user_id: "123"
tools_dir: tools
agents:
  - id: custom-agent
    persona_dir: persona/custom
    channel_ids:
      - "456"
    budget:
      max_turns: "7"
`);

  assert.throws(() => loadConfig(configPath), {
    message: "config.agents[0].budget.max_turns is required and must be a positive integer",
  });
});

test("resolveAgentConfig rejects mixed providers after merging defaults and agent overrides", () => {
  const configPath = writeTempConfig(`
defaults:
  budget:
    model: anthropic/claude-haiku-4-5
    digest_model: anthropic/claude-sonnet-4-6
    max_input_tokens: 8000
    max_output_tokens: 2000
    max_turns: 5
    max_session_cost_cents: 50
    context_strategy: truncate
  conversation:
    window_size: 10
    rate_limit_ms: 1000
  memory:
    max_tokens: 1500
discord:
  allowed_user_id: "123"
tools_dir: tools
agents:
  - id: custom-agent
    persona_dir: persona/custom
    channel_ids:
      - "456"
    budget:
      model: google/gemini-3-flash
`);

  const swarm = loadConfig(configPath);

  assert.throws(() => resolveAgentConfig(swarm.agents[0]!, swarm), {
    message: "config.agents[custom-agent].budget.digest_model must use the same provider as config.agents[custom-agent].budget.model",
  });
});

test("loadConfig rejects mixed providers inside a single complete budget block", () => {
  const configPath = writeTempConfig(`
defaults:
  budget:
    model: google/gemini-3-flash
    digest_model: anthropic/claude-sonnet-4-6
    max_input_tokens: 8000
    max_output_tokens: 2000
    max_turns: 5
    max_session_cost_cents: 50
    context_strategy: truncate
  conversation:
    window_size: 10
    rate_limit_ms: 1000
  memory:
    max_tokens: 1500
discord:
  allowed_user_id: "123"
tools_dir: tools
agents:
  - id: custom-agent
    persona_dir: persona/custom
    channel_ids:
      - "456"
`);

  assert.throws(() => loadConfig(configPath), {
    message: "config.defaults.budget.digest_model must use the same provider as config.defaults.budget.model",
  });
});

test("per-agent env map is preserved in agent config", () => {
  const configPath = writeTempConfig(`
defaults:
  budget:
    model: anthropic/claude-haiku-4-5
    max_input_tokens: 8000
    max_output_tokens: 2000
    max_turns: 5
    max_session_cost_cents: 50
    context_strategy: truncate
  conversation:
    window_size: 10
    rate_limit_ms: 1000
  memory:
    max_tokens: 1500
discord:
  allowed_user_id: "123"
tools_dir: tools
agents:
  - id: test
    persona_dir: persona/test
    channel_ids:
      - "456"
    env:
      ANTHROPIC_API_KEY: MY_CUSTOM_KEY
      DISCORD_TOKEN: MY_BOT_TOKEN
`);

  const config = loadConfig(configPath);
  assert.deepEqual(config.agents[0]!.env, {
    ANTHROPIC_API_KEY: "MY_CUSTOM_KEY",
    DISCORD_TOKEN: "MY_BOT_TOKEN",
  });
});

test("loadConfig parses synthesis_day and synthesis_time", () => {
  const configPath = writeTempConfig(`
defaults:
  budget:
    model: anthropic/claude-haiku-4-5
    max_input_tokens: 8000
    max_output_tokens: 2000
    max_turns: 5
    max_session_cost_cents: 50
    context_strategy: truncate
  conversation:
    window_size: 10
    rate_limit_ms: 1000
  memory:
    max_tokens: 1500
discord:
  allowed_user_id: "123"
tools_dir: tools
agents:
  - id: test
    persona_dir: persona/test
    channel_ids:
      - "456"
    feeds:
      enabled: true
      check_interval_minutes: 15
      waking_hours_start: 8
      waking_hours_end: 23
      channel_id: "789"
      max_items_per_digest: 5
      synthesis_day: 0
      synthesis_time: "10:00"
`);

  const config = loadConfig(configPath);
  assert.equal(config.agents[0]!.feeds!.synthesis_day, 0);
  assert.equal(config.agents[0]!.feeds!.synthesis_time, "10:00");
});

test("loadConfig rejects invalid synthesis_day", () => {
  const configPath = writeTempConfig(`
defaults:
  budget:
    model: anthropic/claude-haiku-4-5
    max_input_tokens: 8000
    max_output_tokens: 2000
    max_turns: 5
    max_session_cost_cents: 50
    context_strategy: truncate
  conversation:
    window_size: 10
    rate_limit_ms: 1000
  memory:
    max_tokens: 1500
discord:
  allowed_user_id: "123"
tools_dir: tools
agents:
  - id: test
    persona_dir: persona/test
    channel_ids:
      - "456"
    feeds:
      enabled: true
      check_interval_minutes: 15
      waking_hours_start: 8
      waking_hours_end: 23
      channel_id: "789"
      max_items_per_digest: 5
      synthesis_day: 7
`);

  assert.throws(() => loadConfig(configPath), {
    message: /synthesis_day.*between 0 and 6/,
  });
});

test("loadConfig rejects invalid synthesis_time", () => {
  const configPath = writeTempConfig(`
defaults:
  budget:
    model: anthropic/claude-haiku-4-5
    max_input_tokens: 8000
    max_output_tokens: 2000
    max_turns: 5
    max_session_cost_cents: 50
    context_strategy: truncate
  conversation:
    window_size: 10
    rate_limit_ms: 1000
  memory:
    max_tokens: 1500
discord:
  allowed_user_id: "123"
tools_dir: tools
agents:
  - id: test
    persona_dir: persona/test
    channel_ids:
      - "456"
    feeds:
      enabled: true
      check_interval_minutes: 15
      waking_hours_start: 8
      waking_hours_end: 23
      channel_id: "789"
      max_items_per_digest: 5
      synthesis_time: "25:00"
`);

  assert.throws(() => loadConfig(configPath), {
    message: /synthesis_time.*invalid time/,
  });
});
