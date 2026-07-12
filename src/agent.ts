import { callWithRetry, estimatePromptTokens, requestFinalDirectAnswer, trimMessagesToBudget } from "./agent-context.ts";
import type { DigestQualityEvaluation, DigestQualityMetrics } from "./digest-metrics.ts";
import {
  evaluateDigestQuality as evalDigestQuality,
  extractDigestContext as extractContext,
} from "./agent-eval.ts";
import { createPromptMetricsEmitter } from "./agent-prompt-metrics.ts";
import { buildAgentSystemPrompt } from "./agent-system-prompt.ts";
import {
  dispatchToolUses,
  extractVisibleText,
  REMEMBER_SCHEMA,
  stripThoughtTextBlocks,
  type ConfirmFn,
  type ToolCallRecord,
} from "./agent-tools.ts";
import type { BudgetTracker } from "./budget.js";
import type { NewsteamConfig } from "./config.js";
import type { ToolExecutor } from "./executor.js";
import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  LLMClient,
  ThinkingLevel,
  ToolUseBlock,
} from "./llm-types.ts";
import type { EventLogger } from "./logger.js";
import type { MemoryManager } from "./memory.js";
import { stripProviderPrefix } from "./model.ts";
import type { ToolRegistry } from "./registry.js";

export type { ConfirmFn, ToolCallRecord } from "./agent-tools.ts";
export type { DigestQualityEvaluation } from "./digest-metrics.ts";

export interface AgentMessage { role: "user" | "assistant"; content: string }

export interface AgentResponse {
  content: string;
  turns: number;
  usage: { inputTokens: number; outputTokens: number; thinkingTokens?: number };
}

export interface AgentLoopInit {
  config: NewsteamConfig;
  budget: BudgetTracker;
  memory: MemoryManager;
  llmClient?: LLMClient;
  registry?: ToolRegistry;
  executor?: ToolExecutor;
  logger?: EventLogger;
  confirmFn?: ConfirmFn;
  agentId?: string;
  channelPersonas?: Record<string, string>;
  retryBaseDelayMs?: number;
  envOverrides?: Record<string, string>;
}

export class AgentLoop {
  private readonly config: NewsteamConfig;
  private readonly budget: BudgetTracker;
  private readonly memory: MemoryManager;
  private readonly llmClient: LLMClient;
  private readonly registry?: ToolRegistry;
  private readonly executor?: ToolExecutor;
  private readonly logger?: EventLogger;
  private readonly confirmFn?: ConfirmFn;
  private readonly agentId: string;
  private readonly canaryToken: string;
  private readonly channelPersonas: Record<string, string>;
  private readonly retryBaseDelayMs: number;
  private readonly envOverrides?: Record<string, string>;
  private readonly conversationWindow: AgentMessage[] = [];
  private lastToolCalls: ToolCallRecord[] = [];
  private lastActivityAt: number = Date.now();

  constructor(init: AgentLoopInit) {
    this.config = init.config;
    this.budget = init.budget;
    this.memory = init.memory;
    if (!init.llmClient) {
      throw new Error("AgentLoop requires an llmClient");
    }
    this.llmClient = init.llmClient;
    this.registry = init.registry;
    this.executor = init.executor;
    this.logger = init.logger;
    this.confirmFn = init.confirmFn;
    this.agentId = init.agentId ?? "default";
    this.canaryToken = this.generateCanary();
    this.channelPersonas = init.channelPersonas ?? {};
    this.retryBaseDelayMs = init.retryBaseDelayMs ?? 2000;
    this.envOverrides = init.envOverrides;
  }

  private logData(data: Record<string, unknown>): Record<string, unknown> {
    return { agent_id: this.agentId, ...data };
  }

  private generateCanary(): string {
    return `CANARY_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;
  }

  buildSystemPrompt(channelId?: string): string {
    return buildAgentSystemPrompt({
      personaDir: this.config.persona_dir,
      memoryContents: this.memory.load(),
      channelPersonas: this.channelPersonas,
      channelId,
      canaryToken: this.canaryToken,
    });
  }

  addMessage(role: AgentMessage["role"], content: string): void {
    this.conversationWindow.push({ role, content });

    while (
      this.conversationWindow.length > this.config.conversation.window_size
    ) {
      this.conversationWindow.shift();
    }
  }

  isIdle(timeoutMinutes: number): boolean {
    return Date.now() - this.lastActivityAt > timeoutMinutes * 60 * 1000;
  }

  checkIdleAndClear(timeoutMinutes: number): { wasIdle: boolean; idleMinutes: number } {
    if (this.isIdle(timeoutMinutes)) {
      const idleMinutes = Math.floor((Date.now() - this.lastActivityAt) / 60_000);
      this.clearWindow();
      return { wasIdle: true, idleMinutes };
    }
    return { wasIdle: false, idleMinutes: 0 };
  }

  async chat(
    userMessage: string,
    channelId?: string,
    options?: { maxTurns?: number; model?: string; thinkingLevel?: ThinkingLevel },
  ): Promise<AgentResponse> {
    this.lastActivityAt = Date.now();
    this.lastToolCalls = [];
    const toolDispatchState = {
      channelId,
      lastToolCalls: this.lastToolCalls,
    };
    this.addMessage("user", userMessage);
    this.logger?.emit("agent.chat.start", this.logData({ message_length: userMessage.length }));

    if (!this.budget.canAfford()) {
      this.logger?.emit("agent.chat.budget_exceeded", this.logData({
        cost_cents: this.budget.getStats().costCents,
        limit_cents: this.config.budget.max_session_cost_cents,
      }));
      throw new Error(
        "Budget exceeded: session cost limit reached",
      );
    }

    const toolSchemas = [REMEMBER_SCHEMA, ...(this.registry?.getToolSchemas() ?? [])];
    const apiMessages: ChatMessage[] =
      this.conversationWindow.map((msg) => ({
        role: msg.role,
        content: msg.content,
      }));

    let totalInput = 0;
    let totalOutput = 0;
    let totalThinking = 0;
    let finalContent = "";
    let turnsUsed = 0;
    let requestIndex = 0;

    const recordUsage = (usage: ChatResponse["usage"], model?: string): void => {
      totalInput += usage.inputTokens;
      totalOutput += usage.outputTokens;
      totalThinking += usage.thinkingTokens ?? 0;
      this.budget.record(usage.inputTokens, usage.billedOutputTokens ?? usage.outputTokens, undefined, model);
    };

    // Summarization calls made while trimming context spend real tokens:
    // count them against the budget and the reply's usage totals.
    const recordSummarizationUsage = (usage: ChatResponse["usage"]): void => {
      recordUsage(usage);
      this.logger?.emit("agent.context.summarized", this.logData({
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
      }));
    };

    const effectiveMaxTurns = options?.maxTurns ?? this.config.budget.max_turns;
    const effectiveModel = options?.model
      ? stripProviderPrefix(options.model)
      : this.getModelName();
    const effectiveThinkingLevel = options?.thinkingLevel ?? this.config.budget.thinking_level;

    const emitPromptMetrics = createPromptMetricsEmitter({
      logger: this.logger,
      logData: (data) => this.logData(data),
      model: effectiveModel,
      thinkingLevel: effectiveThinkingLevel,
      maxInputTokens: this.config.budget.max_input_tokens,
    });

    while (turnsUsed < effectiveMaxTurns) {
      turnsUsed++;
      const isFinalAllowedTurn = turnsUsed === effectiveMaxTurns;

      const systemPrompt = isFinalAllowedTurn
        ? `${this.buildSystemPrompt(channelId)}\n\n## Final turn\nThis is your final allowed model turn for this reply. Give the user your best direct answer now using the conversation and any tool results already available. Do not call any tools.`
        : this.buildSystemPrompt(channelId);
      const messagesBeforeTrim = apiMessages.length;
      const estimatedPromptTokensBeforeTrim = estimatePromptTokens(systemPrompt, apiMessages);
      await trimMessagesToBudget(
        apiMessages,
        systemPrompt,
        this.config.budget.max_input_tokens,
        this.config.budget.context_summary_max_tokens,
        this.config.budget.context_strategy ?? "truncate",
        this.llmClient,
        this.getModelName(),
        recordSummarizationUsage,
      );
      requestIndex += 1;

      const request: ChatRequest = {
        model: effectiveModel,
        maxTokens: this.config.budget.max_output_tokens,
        system: systemPrompt,
        messages: apiMessages,
        tools: isFinalAllowedTurn ? undefined : toolSchemas,
        thinkingLevel: effectiveThinkingLevel,
      };

      let response;
      try {
        response = await callWithRetry(
          this.llmClient, request, this.retryBaseDelayMs,
          this.logger, (data) => this.logData(data),
        );
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.logger?.emit("agent.api.failed", this.logData({ error: errMsg, turns: turnsUsed }));
        finalContent = "🦞 My brain is temporarily offline. Please try again in a minute.";
        break;
      }

      recordUsage(response.usage, options?.model);
      emitPromptMetrics({
        requestKind: "main",
        logicalTurn: turnsUsed,
        requestIndex,
        isFinalAllowedTurn,
        systemPrompt,
        messagesBeforeTrim,
        estimatedPromptTokensBeforeTrim,
        requestMessages: apiMessages,
        activeToolSchemas: isFinalAllowedTurn ? undefined : toolSchemas,
        toolsEnabled: !isFinalAllowedTurn,
        response,
      });

      if (response.stopReason === "max_tokens") {
        this.logger?.emit("agent.response.truncated", this.logData({
          stop_reason: response.stopReason,
          output_tokens: response.usage.outputTokens,
          thinking_tokens: response.usage.thinkingTokens ?? 0,
          billed_output_tokens: response.usage.billedOutputTokens ?? response.usage.outputTokens,
          max_output_tokens: this.config.budget.max_output_tokens,
          turns: turnsUsed,
          model: effectiveModel,
          thinking_level: effectiveThinkingLevel,
        }));
        console.warn(
          `[agent] WARNING: Response hit max_tokens and may be truncated (agent=${this.agentId}, model=${effectiveModel}, output_tokens=${response.usage.outputTokens}, thinking_tokens=${response.usage.thinkingTokens ?? 0}, billed_output_tokens=${response.usage.billedOutputTokens ?? response.usage.outputTokens}, max_output_tokens=${this.config.budget.max_output_tokens}, turn=${turnsUsed})`,
        );
      }

      if (!this.budget.canAfford()) {
        this.logger?.emit("agent.chat.budget_exceeded", {
          cost_cents: this.budget.getStats().costCents,
          limit_cents: this.config.budget.max_session_cost_cents,
        });
        finalContent = "🦞 Hit my budget limit for this turn.";
        break;
      }

      const toolUseBlocks = response.content.filter(
        (block): block is ToolUseBlock => block.type === "tool_use",
      );
      const visibleContent = stripThoughtTextBlocks(response.content);

      // Extract any user-visible text from this response (even if there are also tool calls)
      const textContent = extractVisibleText(visibleContent);

      // Accumulate text from all turns (model may return text alongside tool calls)
      if (textContent.length > 0) {
        let safeText = textContent;
        if (safeText.includes(this.canaryToken)) {
          this.logger?.emit("agent.canary.leaked", this.logData({
            canary: this.canaryToken,
            response_length: safeText.length,
          }));
          console.warn("[canary] WARNING: Model output contains canary token — possible prompt exfiltration");
          safeText = safeText.replaceAll(this.canaryToken, "[REDACTED]");
        }
        finalContent += (finalContent.length > 0 ? "\n" : "") + safeText;
      }

      if (toolUseBlocks.length === 0) {
        // No tool calls — done
        if (textContent.length === 0) {
          this.logger?.emit("agent.response.empty", this.logData({
            turns: turnsUsed,
            stop_reason: response.stopReason,
            model: effectiveModel,
            output_tokens: response.usage.outputTokens,
            thinking_tokens: response.usage.thinkingTokens ?? 0,
            ...(response.providerMetadata ? { provider_metadata: response.providerMetadata } : {}),
          }));
          console.warn(
            `[agent] WARNING: Model returned no text content (agent=${this.agentId}, model=${effectiveModel}, stop_reason=${response.stopReason}, output_tokens=${response.usage.outputTokens}, thinking_tokens=${response.usage.thinkingTokens ?? 0}, turn=${turnsUsed})`,
          );
        }
        break;
      }

      if (isFinalAllowedTurn) {
        if (finalContent === "") {
          const finalRetrySystemPrompt = `${this.buildSystemPrompt(channelId)}\n\n## Final turn\nYou already ran out of tool turns. Reply directly to the user in plain text using only the information in the conversation and tool results. Do not call tools.`;

          const finalRetryText = await requestFinalDirectAnswer({
            llmClient: this.llmClient,
            apiMessages,
            systemPrompt: finalRetrySystemPrompt,
            model: effectiveModel,
            maxTokens: this.config.budget.max_output_tokens,
            maxInputTokens: this.config.budget.max_input_tokens,
            summaryMaxTokens: this.config.budget.context_summary_max_tokens,
            contextStrategy: this.config.budget.context_strategy ?? "truncate",
            trimModelName: this.getModelName(),
            thinkingLevel: effectiveThinkingLevel,
            retryBaseDelayMs: this.retryBaseDelayMs,
            logger: this.logger,
            logData: (data) => this.logData(data),
            onSummarizationUsage: recordSummarizationUsage,
            onResponse: (finalRetryResponse, meta) => {
              requestIndex += 1;
              recordUsage(finalRetryResponse.usage, options?.model);
              emitPromptMetrics({
                requestKind: "final_retry",
                logicalTurn: turnsUsed,
                requestIndex,
                isFinalAllowedTurn: true,
                systemPrompt: finalRetrySystemPrompt,
                messagesBeforeTrim: meta.messagesBeforeTrim,
                estimatedPromptTokensBeforeTrim: meta.estimatedPromptTokensBeforeTrim,
                requestMessages: meta.requestMessages,
                activeToolSchemas: undefined,
                toolsEnabled: false,
                response: finalRetryResponse,
              });
            },
          });

          if (finalRetryText) {
            finalContent = finalRetryText.includes(this.canaryToken)
              ? finalRetryText.replaceAll(this.canaryToken, "[REDACTED]")
              : finalRetryText;
          } else {
            finalContent =
              "🦞 I hit my turn limit before I could finish using tools, so here’s the current state as best I can reconstruct it from the results above.";
          }
        }
        break;
      }

      // Append the assistant message with tool_use blocks
      apiMessages.push({
        role: "assistant",
        content: visibleContent,
      });

      const toolResults = await dispatchToolUses(
        {
          memory: this.memory,
          budget: this.budget,
          registry: this.registry,
          executor: this.executor,
          logger: this.logger,
          confirmFn: this.confirmFn,
          envOverrides: this.envOverrides,
          agentId: this.agentId,
          personaDir: this.config.persona_dir,
          logData: (data) => this.logData(data),
        },
        toolDispatchState,
        toolUseBlocks,
      );

      // Append tool results and re-prompt
      apiMessages.push({
        role: "user",
        content: toolResults,
      });
    }

    // If we exhausted turns without a final text response
    if (turnsUsed >= effectiveMaxTurns && finalContent === "") {
      finalContent =
        "🦞 Hit my turn limit. Here's what I got so far: (no final response)";
    }

    this.addMessage("assistant", finalContent);

    const costCents = this.budget.getStats().costCents;
    this.logger?.emit("agent.chat.end", this.logData({
      input_tokens: totalInput,
      output_tokens: totalOutput,
      thinking_tokens: totalThinking,
      cost_cents: costCents,
      turns: turnsUsed,
    }));

    return {
      content: finalContent,
      turns: turnsUsed,
      usage: {
        inputTokens: totalInput,
        outputTokens: totalOutput,
        thinkingTokens: totalThinking,
      },
    };
  }

  getWindow(): AgentMessage[] {
    return this.conversationWindow.map((message) => ({ ...message }));
  }

  clearWindow(): void {
    this.conversationWindow.length = 0;
  }

  getBudgetStats(): { toolCalls: number; toolUsage: Record<string, number>; costCents: number; turns: number } {
    const stats = this.budget.getStats();
    return { toolCalls: stats.toolCalls, toolUsage: stats.toolUsage, costCents: stats.costCents, turns: stats.turns };
  }

  getLastToolCalls(): ToolCallRecord[] {
    return this.lastToolCalls.map((call) => ({
      ...call,
      args: { ...call.args },
    }));
  }

  async evaluateDigestQuality(input: {
    digestText: string;
    items: Array<{ feed_name?: string; title?: string; url?: string; snippet?: string | null }>;
    metrics: DigestQualityMetrics;
    model?: string;
    thinkingLevel?: ThinkingLevel;
  }): Promise<DigestQualityEvaluation | null> {
    return evalDigestQuality(this.evalDeps(input.model, input.thinkingLevel ?? "minimal"), input);
  }

  async extractDigestContext(
    digestText: string,
    options?: { model?: string; thinkingLevel?: ThinkingLevel },
  ): Promise<{ timestamp: string; topics: string[]; entities: string[]; sentiment: string; summary: string; interests_served: string[] } | null> {
    return extractContext(this.evalDeps(options?.model, options?.thinkingLevel), digestText);
  }

  private evalDeps(modelOverride?: string, thinkingLevel?: ThinkingLevel) {
    return {
      llmClient: this.llmClient,
      budget: this.budget,
      model: modelOverride ? stripProviderPrefix(modelOverride) : this.getModelName(),
      modelLabel: modelOverride ?? this.config.budget.model,
      thinkingLevel,
      logger: this.logger,
      logData: (data: Record<string, unknown>) => this.logData(data),
    };
  }

  private getModelName(): string {
    return stripProviderPrefix(this.config.budget.model);
  }

}
