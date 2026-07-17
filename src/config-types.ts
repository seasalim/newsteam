import type { ThinkingLevel } from "./llm-types.ts";

export interface BudgetConfig {
  model: string;
  digest_model?: string;
  thinking_level?: ThinkingLevel;
  digest_thinking_level?: ThinkingLevel;
  max_input_tokens: number;
  max_output_tokens: number;
  context_summary_max_tokens: number;
  max_turns: number;
  max_session_cost_cents: number;
  context_strategy: string;
  monthly_budget_cents?: number;
}

export interface DiscordConfig {
  allowed_user_id?: string;
  allowed_channel_ids: string[];
}

export type ChannelProvider = "discord" | "local";

export interface ConversationConfig {
  window_size: number;
  rate_limit_ms: number;
  idle_timeout_minutes?: number;
}

export interface MemoryConfig {
  max_tokens: number;
}

export interface FeedsConfig {
  enabled: boolean;
  check_interval_minutes: number;
  waking_hours_start: number;
  waking_hours_end: number;
  channel_id: string;
  max_items_per_digest: number;
  max_queue_age_hours?: number;
  max_content_age_hours?: number;
  digest_times?: string[];
  digest_max_turns?: number;
  synthesis_day?: number;
  synthesis_time?: string;
}

export interface NewsteamConfig {
  budget: BudgetConfig;
  discord: DiscordConfig;
  conversation: ConversationConfig;
  persona_dir: string;
  tools_dir: string;
  memory: MemoryConfig;
  feeds?: FeedsConfig;
  confirmation_timeout_ms?: number;
  channel_personas?: Record<string, string>;
}

export interface AgentConfig {
  id: string;
  persona_dir: string;
  channel_ids: string[];
  budget?: Partial<BudgetConfig>;
  env?: Record<string, string>;
  feeds?: FeedsConfig;
  channel_personas?: Record<string, string>;
}

export interface SwarmConfig {
  channel: { provider: ChannelProvider };
  discord?: { allowed_user_id: string };
  defaults: {
    budget: BudgetConfig;
    conversation: ConversationConfig;
    memory: MemoryConfig;
  };
  tools_dir: string;
  confirmation_timeout_ms: number;
  agents: AgentConfig[];
}
