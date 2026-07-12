import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

import { formatDollarsFromCents } from "./model-cost.ts";

interface LedgerLine {
  date: string;
  input_tokens: number;
  output_tokens: number;
  cost_cents: number;
  turns: number;
  tool_calls: number;
}

interface RecordStats {
  inputTokens: number;
  outputTokens: number;
  costCents: number;
  turns: number;
  toolCalls: number;
  source?: string;   // "chat" | "digest" | "synthesis"
  agentId?: string;
}

function todayString(): string {
  return new Date().toISOString().slice(0, 10);
}

function currentMonthPrefix(): string {
  return new Date().toISOString().slice(0, 7);
}

export class CostLedger {
  private readonly ledgerDir: string;
  private readonly ledgerPath: string;

  constructor(ledgerDir: string = path.resolve("logs")) {
    this.ledgerDir = ledgerDir;
    this.ledgerPath = path.join(this.ledgerDir, "cost-ledger.jsonl");
  }

  record(stats: RecordStats): void {
    mkdirSync(this.ledgerDir, { recursive: true });

    const today = todayString();
    const lines = this.readAllLines();

    let found = false;
    const updatedLines: LedgerLine[] = [];

    for (const line of lines) {
      if (line.date === today) {
        updatedLines.push({
          date: today,
          input_tokens: line.input_tokens + stats.inputTokens,
          output_tokens: line.output_tokens + stats.outputTokens,
          cost_cents: line.cost_cents + stats.costCents,
          turns: line.turns + stats.turns,
          tool_calls: line.tool_calls + stats.toolCalls,
        });
        found = true;
      } else {
        updatedLines.push(line);
      }
    }

    if (!found) {
      updatedLines.push({
        date: today,
        input_tokens: stats.inputTokens,
        output_tokens: stats.outputTokens,
        cost_cents: stats.costCents,
        turns: stats.turns,
        tool_calls: stats.toolCalls,
      });
    }

    // Atomic write: write to .tmp then rename
    const tmpPath = this.ledgerPath + ".tmp";
    const content = updatedLines.map((l) => JSON.stringify(l)).join("\n") + "\n";
    writeFileSync(tmpPath, content, "utf8");
    renameSync(tmpPath, this.ledgerPath);
  }

  getTodayCost(): { costCents: number; turns: number } {
    const today = todayString();
    const lines = this.readAllLines();
    const todayLine = lines.find((l) => l.date === today);

    if (!todayLine) {
      return { costCents: 0, turns: 0 };
    }

    return { costCents: todayLine.cost_cents, turns: todayLine.turns };
  }

  getMonthCost(): { costCents: number; turns: number; days: number } {
    const monthPrefix = currentMonthPrefix();
    const lines = this.readAllLines();
    const monthLines = lines.filter((l) => l.date.startsWith(monthPrefix));

    let costCents = 0;
    let turns = 0;

    for (const line of monthLines) {
      costCents += line.cost_cents;
      turns += line.turns;
    }

    return { costCents, turns, days: monthLines.length };
  }

  formatCostReport(monthlyBudgetCents?: number): string {
    const today = this.getTodayCost();
    const month = this.getMonthCost();

    const lines = [
      "Cost Ledger",
      "────────────────────────",
      `Today:   $${formatDollarsFromCents(today.costCents)} (${today.turns} turns)`,
      `Month:   $${formatDollarsFromCents(month.costCents)} (${month.turns} turns, ${month.days} day${month.days === 1 ? "" : "s"})`,
    ];

    if (monthlyBudgetCents !== undefined) {
      const pct = month.costCents > 0
        ? ((month.costCents / monthlyBudgetCents) * 100).toFixed(1)
        : "0.0";
      lines.push(
        `Budget:  $${formatDollarsFromCents(month.costCents)} / $${formatDollarsFromCents(monthlyBudgetCents)} (${pct}%)`,
      );
    }

    return lines.join("\n");
  }

  private readAllLines(): LedgerLine[] {
    if (!existsSync(this.ledgerPath)) {
      return [];
    }

    try {
      const content = readFileSync(this.ledgerPath, "utf8");
      return content
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as LedgerLine);
    } catch {
      return [];
    }
  }
}
