import { readFileSync } from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

import type { ThinkingLevel } from "./llm-types.ts";
import type {
  AgentConfig,
  BudgetConfig,
  ConversationConfig,
  FeedsConfig,
  MemoryConfig,
  NewsteamConfig,
  SwarmConfig,
} from "./config-types.ts";
export type {
  AgentConfig,
  BudgetConfig,
  ChannelProvider,
  ConversationConfig,
  DiscordConfig,
  FeedsConfig,
  MemoryConfig,
  NewsteamConfig,
  SwarmConfig,
} from "./config-types.ts";
import {
  isConfigObject,
  requireBoolean,
  requireEnum,
  requireIntegerInRange,
  requireObject,
  requirePositiveInteger,
  requireString,
  requireStringArray,
  validateTimeStrings,
  type ConfigObject,
} from "./config-validators.ts";
import { validateMatchingModelProviders } from "./model.ts";
import { isKnownCostModel } from "./model-cost.ts";
import { validateChannelSelection } from "./channel-config.ts";

/** Resolve an AgentConfig + SwarmConfig defaults into a fully populated NewsteamConfig. */
export function resolveAgentConfig(agent: AgentConfig, swarm: SwarmConfig): NewsteamConfig {
  const mergedBudget: BudgetConfig = { ...swarm.defaults.budget, ...agent.budget };
  if (
    agent.budget?.max_output_tokens !== undefined &&
    agent.budget.context_summary_max_tokens === undefined
  ) {
    mergedBudget.context_summary_max_tokens = Math.min(
      mergedBudget.context_summary_max_tokens,
      agent.budget.max_output_tokens,
    );
  }
  const budget = validateBudgetConfig(
    mergedBudget,
    `config.agents[${agent.id}].budget`,
  );

  return {
    budget,
    discord: {
      allowed_user_id: swarm.discord?.allowed_user_id,
      allowed_channel_ids: agent.channel_ids,
    },
    conversation: swarm.defaults.conversation,
    persona_dir: agent.persona_dir,
    tools_dir: swarm.tools_dir,
    memory: swarm.defaults.memory,
    feeds: agent.feeds,
    confirmation_timeout_ms: swarm.confirmation_timeout_ms,
    channel_personas: agent.channel_personas,
  };
}

// ── Validation ──────────────────────────────────────────────────────

const VALID_CONTEXT_STRATEGIES = new Set(["truncate", "summarize"]);
const VALID_THINKING_LEVELS = new Set<ThinkingLevel>(["minimal", "low", "medium", "high"]);
const DEFAULT_CONTEXT_SUMMARY_MAX_TOKENS = 500;

// ── Section validators ──────────────────────────────────────────────

function validateBudgetConfig(value: unknown, prefix = "config.budget"): BudgetConfig {
  const budget = requireObject(value, prefix);
  const maxOutputTokens = requirePositiveInteger(
    budget.max_output_tokens,
    `${prefix}.max_output_tokens`,
  );
  const contextSummaryMaxTokens = budget.context_summary_max_tokens !== undefined
    ? requirePositiveInteger(
      budget.context_summary_max_tokens,
      `${prefix}.context_summary_max_tokens`,
    )
    : Math.min(DEFAULT_CONTEXT_SUMMARY_MAX_TOKENS, maxOutputTokens);

  if (contextSummaryMaxTokens > maxOutputTokens) {
    throw new Error(
      `${prefix}.context_summary_max_tokens must be less than or equal to ${prefix}.max_output_tokens`,
    );
  }

  const result = {
    model: requireString(budget.model, `${prefix}.model`),
    digest_model: budget.digest_model !== undefined
      ? requireString(budget.digest_model, `${prefix}.digest_model`)
      : undefined,
    thinking_level: budget.thinking_level !== undefined
      ? requireEnum(budget.thinking_level, `${prefix}.thinking_level`, VALID_THINKING_LEVELS) as ThinkingLevel
      : undefined,
    digest_thinking_level: budget.digest_thinking_level !== undefined
      ? requireEnum(budget.digest_thinking_level, `${prefix}.digest_thinking_level`, VALID_THINKING_LEVELS) as ThinkingLevel
      : undefined,
    max_input_tokens: requirePositiveInteger(budget.max_input_tokens, `${prefix}.max_input_tokens`),
    max_output_tokens: maxOutputTokens,
    context_summary_max_tokens: contextSummaryMaxTokens,
    max_turns: requirePositiveInteger(budget.max_turns, `${prefix}.max_turns`),
    max_session_cost_cents: requirePositiveInteger(budget.max_session_cost_cents, `${prefix}.max_session_cost_cents`),
    context_strategy: requireEnum(budget.context_strategy, `${prefix}.context_strategy`, VALID_CONTEXT_STRATEGIES),
    monthly_budget_cents: budget.monthly_budget_cents !== undefined
      ? requirePositiveInteger(budget.monthly_budget_cents, `${prefix}.monthly_budget_cents`)
      : undefined,
  };

  validateMatchingModelProviders(result.model, result.digest_model, prefix);

  warnUnknownCostModel(result.model, `${prefix}.model`);
  if (result.digest_model) {
    warnUnknownCostModel(result.digest_model, `${prefix}.digest_model`);
  }

  return result;
}

const warnedCostModelFields = new Set<string>();

function warnUnknownCostModel(model: string, fieldPath: string): void {
  if (isKnownCostModel(model)) {
    return;
  }

  const key = `${fieldPath}:${model}`;
  if (warnedCostModelFields.has(key)) {
    return;
  }
  warnedCostModelFields.add(key);

  console.warn(
    `[config] WARNING: ${fieldPath} is "${model}", which has no entry in MODEL_COST_RATES ` +
    `(src/model-cost.ts). Cost tracking and budget enforcement will use default rates.`,
  );
}

function validateBudgetOverride(value: unknown, prefix: string): Partial<BudgetConfig> {
  const budget = requireObject(value, prefix);
  const result: Partial<BudgetConfig> = {};

  if (budget.model !== undefined) {
    result.model = requireString(budget.model, `${prefix}.model`);
  }

  if (budget.digest_model !== undefined) {
    result.digest_model = requireString(budget.digest_model, `${prefix}.digest_model`);
  }

  if (budget.thinking_level !== undefined) {
    result.thinking_level = requireEnum(
      budget.thinking_level,
      `${prefix}.thinking_level`,
      VALID_THINKING_LEVELS,
    ) as ThinkingLevel;
  }

  if (budget.digest_thinking_level !== undefined) {
    result.digest_thinking_level = requireEnum(
      budget.digest_thinking_level,
      `${prefix}.digest_thinking_level`,
      VALID_THINKING_LEVELS,
    ) as ThinkingLevel;
  }

  if (budget.max_input_tokens !== undefined) {
    result.max_input_tokens = requirePositiveInteger(budget.max_input_tokens, `${prefix}.max_input_tokens`);
  }

  if (budget.max_output_tokens !== undefined) {
    result.max_output_tokens = requirePositiveInteger(budget.max_output_tokens, `${prefix}.max_output_tokens`);
  }

  if (budget.context_summary_max_tokens !== undefined) {
    result.context_summary_max_tokens = requirePositiveInteger(
      budget.context_summary_max_tokens,
      `${prefix}.context_summary_max_tokens`,
    );
  }

  if (budget.max_turns !== undefined) {
    result.max_turns = requirePositiveInteger(budget.max_turns, `${prefix}.max_turns`);
  }

  if (budget.max_session_cost_cents !== undefined) {
    result.max_session_cost_cents = requirePositiveInteger(
      budget.max_session_cost_cents,
      `${prefix}.max_session_cost_cents`,
    );
  }

  if (budget.context_strategy !== undefined) {
    result.context_strategy = requireEnum(
      budget.context_strategy,
      `${prefix}.context_strategy`,
      VALID_CONTEXT_STRATEGIES,
    );
  }

  if (budget.monthly_budget_cents !== undefined) {
    result.monthly_budget_cents = requirePositiveInteger(
      budget.monthly_budget_cents,
      `${prefix}.monthly_budget_cents`,
    );
  }

  return result;
}


function validateConversationConfig(value: unknown, prefix = "config.defaults.conversation"): ConversationConfig {
  const conversation = requireObject(value, prefix);

  return {
    window_size: requirePositiveInteger(conversation.window_size, `${prefix}.window_size`),
    rate_limit_ms: requirePositiveInteger(conversation.rate_limit_ms, `${prefix}.rate_limit_ms`),
    idle_timeout_minutes: conversation.idle_timeout_minutes !== undefined
      ? requirePositiveInteger(conversation.idle_timeout_minutes, `${prefix}.idle_timeout_minutes`)
      : undefined,
  };
}


function validateMemoryConfig(value: unknown, prefix = "config.defaults.memory"): MemoryConfig {
  const memory = requireObject(value, prefix);

  return {
    max_tokens: requirePositiveInteger(memory.max_tokens, `${prefix}.max_tokens`),
  };
}


function validateChannelPersonas(value: unknown, prefix: string): Record<string, string> {
  if (!isConfigObject(value)) {
    throw new Error(`${prefix} must be an object`);
  }
  const result: Record<string, string> = {};
  for (const [key, val] of Object.entries(value)) {
    if (typeof val !== "string") {
      throw new Error(`${prefix}.${key} must be a string (filename)`);
    }
    result[key] = val;
  }
  return result;
}

export function validateFeedsConfig(value: unknown, prefix = "config.feeds"): FeedsConfig | undefined {
  if (value === undefined) {
    return undefined;
  }

  const feeds = requireObject(value, prefix);
  const maxQueueAgeHours = feeds.max_queue_age_hours !== undefined
    ? requirePositiveInteger(feeds.max_queue_age_hours, `${prefix}.max_queue_age_hours`)
    : feeds.pending_max_age_hours !== undefined
      ? requirePositiveInteger(feeds.pending_max_age_hours, `${prefix}.pending_max_age_hours`)
      : undefined;

  return {
    enabled: requireBoolean(feeds.enabled, `${prefix}.enabled`),
    check_interval_minutes: requirePositiveInteger(feeds.check_interval_minutes, `${prefix}.check_interval_minutes`),
    waking_hours_start: requireIntegerInRange(feeds.waking_hours_start, `${prefix}.waking_hours_start`, 0, 23),
    waking_hours_end: requireIntegerInRange(feeds.waking_hours_end, `${prefix}.waking_hours_end`, 0, 23),
    channel_id: requireString(feeds.channel_id, `${prefix}.channel_id`),
    max_items_per_digest: requirePositiveInteger(feeds.max_items_per_digest, `${prefix}.max_items_per_digest`),
    max_queue_age_hours: maxQueueAgeHours,
    max_content_age_hours: feeds.max_content_age_hours !== undefined
      ? requirePositiveInteger(feeds.max_content_age_hours, `${prefix}.max_content_age_hours`)
      : undefined,
    digest_times: feeds.digest_times !== undefined
      ? validateTimeStrings(
          requireStringArray(feeds.digest_times, `${prefix}.digest_times`),
          `${prefix}.digest_times`
        )
      : undefined,
    digest_max_turns: feeds.digest_max_turns !== undefined
      ? requirePositiveInteger(feeds.digest_max_turns, `${prefix}.digest_max_turns`)
      : undefined,
    synthesis_day: feeds.synthesis_day !== undefined
      ? requireIntegerInRange(feeds.synthesis_day, `${prefix}.synthesis_day`, 0, 6)
      : undefined,
    synthesis_time: feeds.synthesis_time !== undefined
      ? validateTimeStrings([requireString(feeds.synthesis_time, `${prefix}.synthesis_time`)], `${prefix}.synthesis_time`)[0]
      : undefined,
  };
}

function validateEnvMap(value: unknown, prefix: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isConfigObject(value)) {
    throw new Error(`${prefix} must be an object`);
  }
  const result: Record<string, string> = {};
  for (const [key, val] of Object.entries(value)) {
    if (typeof val !== "string") {
      throw new Error(`${prefix}.${key} must be a string (env var name)`);
    }
    result[key] = val;
  }
  return result;
}

function validateAgentConfig(value: unknown, index: number): AgentConfig {
  const prefix = `config.agents[${index}]`;
  const agent = requireObject(value, prefix);

  const id = requireString(agent.id, `${prefix}.id`);
  const persona_dir = requireString(agent.persona_dir, `${prefix}.persona_dir`);
  const channel_ids = requireStringArray(agent.channel_ids, `${prefix}.channel_ids`);

  if (channel_ids.length === 0) {
    throw new Error(`${prefix}.channel_ids must contain at least one channel`);
  }

  return {
    id,
    persona_dir,
    channel_ids,
    budget: agent.budget !== undefined
      ? validateBudgetOverride(agent.budget, `${prefix}.budget`)
      : undefined,
    env: validateEnvMap(agent.env, `${prefix}.env`),
    feeds: validateFeedsConfig(agent.feeds, `${prefix}.feeds`),
    channel_personas: agent.channel_personas !== undefined
      ? validateChannelPersonas(agent.channel_personas, `${prefix}.channel_personas`)
      : undefined,
  };
}

function validateSwarmConfig(config: ConfigObject): SwarmConfig {
  const defaults = requireObject(config.defaults, "config.defaults");
  const { channel, discord } = validateChannelSelection(config.channel, config.discord);
  const tools_dir = requireString(config.tools_dir ?? (defaults as ConfigObject).tools_dir, "config.tools_dir");

  const budgetConfig = validateBudgetConfig(defaults.budget, "config.defaults.budget");
  const conversationConfig = validateConversationConfig(defaults.conversation, "config.defaults.conversation");
  const memoryConfig = validateMemoryConfig(defaults.memory, "config.defaults.memory");

  if (!Array.isArray(config.agents) || config.agents.length === 0) {
    throw new Error("config.agents is required and must be a non-empty array");
  }

  const agents = config.agents.map((entry: unknown, i: number) => validateAgentConfig(entry, i));

  // Validate no duplicate agent IDs
  const ids = new Set<string>();
  for (const agent of agents) {
    if (ids.has(agent.id)) {
      throw new Error(`Duplicate agent id: "${agent.id}"`);
    }
    ids.add(agent.id);
  }

  // Validate no overlapping channel IDs
  const channelOwners = new Map<string, string>();
  for (const agent of agents) {
    const ownedChannels = new Set(agent.channel_ids);
    if (agent.feeds?.channel_id) ownedChannels.add(agent.feeds.channel_id);
    for (const ch of ownedChannels) {
      const existing = channelOwners.get(ch);
      if (existing) {
        throw new Error(`Channel "${ch}" is assigned to both agents "${existing}" and "${agent.id}"`);
      }
      channelOwners.set(ch, agent.id);
    }
  }

  // Warn (don't fail) when agents share a digest time: their digest sessions
  // run on separate job queues, so shared times mean concurrent multi-turn
  // LLM bursts — enough to trip free-tier RPM limits.
  const digestTimeOwners = new Map<string, string>();
  for (const agent of agents) {
    for (const time of agent.feeds?.digest_times ?? []) {
      const existing = digestTimeOwners.get(time);
      if (existing) {
        console.warn(
          `[config] WARNING: digest time "${time}" is shared by agents "${existing}" and "${agent.id}". ` +
          `Their digests will run concurrently, which can exceed rate limits on free API plans — ` +
          `stagger digest_times (e.g. offset by 30 minutes).`,
        );
      } else {
        digestTimeOwners.set(time, agent.id);
      }
    }
  }

  const confirmation_timeout_ms = config.confirmation_timeout_ms !== undefined
    ? requirePositiveInteger(config.confirmation_timeout_ms as number, "config.confirmation_timeout_ms")
    : 120_000;

  return {
    channel,
    discord,
    defaults: {
      budget: budgetConfig,
      conversation: conversationConfig,
      memory: memoryConfig,
    },
    tools_dir,
    confirmation_timeout_ms,
    agents,
  };
}

// ── Legacy format support ───────────────────────────────────────────

/** Detect and convert old flat config format to swarm format. */
function isLegacyFormat(config: ConfigObject): boolean {
  return config.agents === undefined && config.budget !== undefined;
}

function convertLegacyConfig(config: ConfigObject): ConfigObject {
  const discord = config.discord as ConfigObject | undefined;
  const channel_ids = discord?.allowed_channel_ids as string[] | undefined;
  const feeds = config.feeds as ConfigObject | undefined;

  return {
    defaults: {
      budget: config.budget,
      conversation: config.conversation,
      memory: config.memory,
    },
    discord: {
      allowed_user_id: discord?.allowed_user_id,
    },
    tools_dir: config.tools_dir,
    confirmation_timeout_ms: config.confirmation_timeout_ms,
    agents: [
      {
        id: "default",
        persona_dir: config.persona_dir,
        channel_ids: channel_ids ?? [],
        feeds,
        channel_personas: config.channel_personas,
      },
    ],
  };
}

// ── Public API ───────────────────────────────────────────────────────

export function loadConfig(configPath = "config.yaml"): SwarmConfig {
  const resolvedPath = path.isAbsolute(configPath)
    ? configPath
    : path.resolve(process.cwd(), configPath);

  let fileContents: string;

  try {
    fileContents = readFileSync(resolvedPath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : "";
    const setupHint = code === "ENOENT"
      ? " Copy config.example.yaml to config.yaml first: cp config.example.yaml config.yaml."
      : "";
    throw new Error(`Failed to read config file at ${resolvedPath}:${setupHint} ${message}`);
  }

  let parsedConfig: unknown;

  try {
    parsedConfig = yaml.load(fileContents);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse config file at ${resolvedPath}: ${message}`);
  }

  let config = requireObject(parsedConfig, "config");

  if (isLegacyFormat(config)) {
    config = convertLegacyConfig(config);
  }

  return validateSwarmConfig(config);
}
