import type { BudgetConfig } from "./config.js";
import { estimateCostCents, formatDollarsFromCents } from "./model-cost.ts";

export interface SessionStats {
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  costCents: number;
  turns: number;
  toolUsage: Record<string, number>;
  startedAt: Date;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatUptime(startedAt: Date): string {
  const elapsedMs = Math.max(0, Date.now() - startedAt.getTime());
  const totalMinutes = Math.floor(elapsedMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours === 0) {
    return `${minutes}m`;
  }

  return `${hours}h ${minutes}m`;
}

export class BudgetTracker {
  private readonly config: BudgetConfig;
  private readonly agentId: string;

  private stats: SessionStats;

  constructor(config: BudgetConfig, agentId: string = "default") {
    this.config = config;
    this.agentId = agentId;
    this.stats = this.createEmptyStats();
  }

  record(inputTokens: number, outputTokens: number, toolName?: string, model?: string): void {
    const turnCostCents = estimateCostCents(
      model ?? this.config.model,
      inputTokens,
      outputTokens,
    );

    this.stats.inputTokens += inputTokens;
    this.stats.outputTokens += outputTokens;
    this.stats.costCents += turnCostCents;

    // Only count as a model turn when there are actual LLM tokens.
    // Tool-only records (0 input + 0 output tokens) are tool events, not turns.
    if (inputTokens > 0 || outputTokens > 0) {
      this.stats.turns += 1;
    }

    if (toolName) {
      this.stats.toolCalls += 1;
      this.stats.toolUsage[toolName] = (this.stats.toolUsage[toolName] ?? 0) + 1;
    }
  }

  /**
   * Check if we can afford another LLM call based on session cost limit.
   * This is the session-level gate — used before each user message.
   */
  canAfford(): boolean {
    return this.stats.costCents < this.config.max_session_cost_cents;
  }

  formatInline(): string {
    return `📊 session in: ${formatNumber(this.stats.inputTokens)} | out: ${formatNumber(this.stats.outputTokens)} | tools: ${formatNumber(this.stats.toolCalls)} | cost: $${formatDollarsFromCents(this.stats.costCents)}`;
  }

  formatStats(): string {
    const toolUsageEntries = Object.entries(this.stats.toolUsage).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    const toolUsageBlock =
      toolUsageEntries.length === 0
        ? "  none"
        : toolUsageEntries
            .map(
              ([toolName, count]) =>
                `  ${toolName}: ${count} call${count === 1 ? "" : "s"}`,
            )
            .join("\n");

    return [
      `${this.agentId} Session Stats`,
      "────────────────────────",
      `Session turns:        ${formatNumber(this.stats.turns)} / ${formatNumber(this.config.max_turns)}`,
      `Total input tokens:   ${formatNumber(this.stats.inputTokens)}`,
      `Total output tokens:  ${formatNumber(this.stats.outputTokens)}`,
      `Total tool calls:     ${formatNumber(this.stats.toolCalls)}`,
      `Session cost:         $${formatDollarsFromCents(this.stats.costCents)}`,
      `Started:              ${this.stats.startedAt.toISOString()}`,
      `Uptime:               ${formatUptime(this.stats.startedAt)}`,
      `Model:                ${this.config.model}`,
      "",
      "Tool usage:",
      toolUsageBlock,
    ].join("\n");
  }

  getStats(): SessionStats {
    return {
      ...this.stats,
      startedAt: new Date(this.stats.startedAt),
      toolUsage: { ...this.stats.toolUsage },
    };
  }

  reset(): void {
    this.stats = this.createEmptyStats();
  }

  private createEmptyStats(): SessionStats {
    return {
      inputTokens: 0,
      outputTokens: 0,
      toolCalls: 0,
      costCents: 0,
      turns: 0,
      toolUsage: {},
      startedAt: new Date(),
    };
  }
}
