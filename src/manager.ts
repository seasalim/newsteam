import path from "node:path";

import { AgentLoop, type AgentLoopInit, type ConfirmFn } from "./agent.js";
import { BudgetTracker } from "./budget.js";
import type { AgentConfig, NewsteamConfig, SwarmConfig } from "./config.js";
import { resolveAgentConfig } from "./config.js";
import { ToolExecutor } from "./executor.js";
import type { LLMClient } from "./llm-types.ts";
import type { EventLogger } from "./logger.js";
import { MemoryManager } from "./memory.js";
import { getModelProvider } from "./model.ts";
import { createAnthropicClient } from "./provider-anthropic.ts";
import { createGeminiClient } from "./provider-gemini.ts";
import { createOpenAIClient } from "./provider-openai.ts";
import type { ToolRegistry } from "./registry.js";

export interface AgentInstance {
  id: string;
  config: NewsteamConfig;
  raw: AgentConfig;
  agentLoop: AgentLoop;
  budget: BudgetTracker;
  memory: MemoryManager;
  /** Resolve a logical env var name to its actual env var name for this agent. */
  resolveEnvName(logicalName: string): string;
}

export class AgentManager {
  private readonly agents = new Map<string, AgentInstance>();
  private readonly channelToAgent = new Map<string, AgentInstance>();

  constructor(
    swarmConfig: SwarmConfig,
    registry: ToolRegistry,
    executor: ToolExecutor,
    logger: EventLogger,
    buildConfirmFn: (instance: AgentInstance) => ConfirmFn,
  ) {
    for (const agentConfig of swarmConfig.agents) {
      const resolved = resolveAgentConfig(agentConfig, swarmConfig);
      const budget = new BudgetTracker(resolved.budget, agentConfig.id);
      const memory = new MemoryManager(
        path.resolve(agentConfig.persona_dir, "MEMORY.md"),
        resolved.memory.max_tokens,
      );

      // Build a partial instance so buildConfirmFn can reference it;
      // agentLoop is assigned immediately after.
      const instance = {
        id: agentConfig.id,
        config: resolved,
        raw: agentConfig,
        budget,
        memory,
        resolveEnvName(logicalName: string): string {
          return agentConfig.env?.[logicalName] ?? logicalName;
        },
      } as AgentInstance;

      const confirmFn = buildConfirmFn(instance);
      const modelProvider = getModelProvider(resolved.budget.model);
      let llmClient: LLMClient;

      if (modelProvider === "google") {
        const apiKeyEnvName = instance.resolveEnvName("GOOGLE_API_KEY");
        const apiKey = process.env[apiKeyEnvName];
        if (!apiKey) {
          throw new Error(`Missing ${apiKeyEnvName} for Gemini agent "${agentConfig.id}"`);
        }
        llmClient = createGeminiClient(apiKey, resolved.budget.model);
      } else if (modelProvider === "openai") {
        const apiKeyEnvName = instance.resolveEnvName("OPENAI_API_KEY");
        const apiKey = process.env[apiKeyEnvName];
        if (!apiKey) {
          throw new Error(`Missing ${apiKeyEnvName} for OpenAI agent "${agentConfig.id}"`);
        }
        llmClient = createOpenAIClient(apiKey, resolved.budget.model);
      } else {
        const apiKeyEnvName = instance.resolveEnvName("ANTHROPIC_API_KEY");
        const apiKey = process.env[apiKeyEnvName];
        if (!apiKey) {
          throw new Error(`Missing ${apiKeyEnvName} for Anthropic agent "${agentConfig.id}"`);
        }
        llmClient = createAnthropicClient(apiKey, resolved.budget.model);
      }

      instance.agentLoop = new AgentLoop({
        config: resolved,
        budget,
        memory,
        llmClient,
        registry,
        executor,
        logger,
        confirmFn,
        agentId: agentConfig.id,
        channelPersonas: resolved.channel_personas,
        envOverrides: agentConfig.env,
      });

      this.agents.set(agentConfig.id, instance);

      for (const channelId of agentConfig.channel_ids) {
        this.channelToAgent.set(channelId, instance);
      }
    }
  }

  getAgentForChannel(channelId: string): AgentInstance | undefined {
    return this.channelToAgent.get(channelId);
  }

  getAgent(id: string): AgentInstance | undefined {
    return this.agents.get(id);
  }

  getAllAgents(): AgentInstance[] {
    return [...this.agents.values()];
  }

  getAllChannelIds(): string[] {
    return [...this.channelToAgent.keys()];
  }

  shutdown(): void {
    for (const instance of this.agents.values()) {
      instance.memory.flush();
    }
  }
}
