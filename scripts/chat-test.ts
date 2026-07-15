#!/usr/bin/env node --experimental-strip-types
/**
 * Quick interactive chat test for the NewsTeam agent loop.
 * Run: node --experimental-strip-types scripts/chat-test.ts
 */
import { createInterface } from "node:readline";
import { config as loadEnv } from "dotenv";

loadEnv();

import { loadConfig } from "../src/config.ts";
import { BudgetTracker } from "../src/budget.ts";
import { MemoryManager } from "../src/memory.ts";
import { ToolRegistry } from "../src/registry.ts";
import { ToolExecutor } from "../src/executor.ts";
import { AgentLoop } from "../src/agent.ts";

const cfg = loadConfig();
const budget = new BudgetTracker(cfg.budget);
const memory = new MemoryManager("persona/MEMORY.md", cfg.memory.max_tokens);

const registry = new ToolRegistry(cfg.tools_dir);
registry.loadAll();
const tools = registry.getAll();
console.log(`🔧 Tools: ${tools.map(t => t.name).join(", ") || "none"}`);

const executor = new ToolExecutor(cfg.tools_dir);
const agent = new AgentLoop({ config: cfg, budget, memory, registry, executor });

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
});

console.log("🦞 NewsTeam chat test (Ctrl+C to quit)");
console.log(`   Model: ${cfg.budget.model}`);
console.log(`   Budget: ${cfg.budget.max_turns} turns, ${cfg.budget.max_session_cost_cents}¢ max`);
console.log("");

function prompt() {
  rl.question("You: ", async (input) => {
    const trimmed = input.trim();
    if (!trimmed) {
      prompt();
      return;
    }

    try {
      const response = await agent.chat(trimmed);
      console.log(`\nAgent: ${response.content}`);
      console.log(`${budget.formatInline()}\n`);
    } catch (err) {
      console.error(`\n❌ ${err instanceof Error ? err.message : String(err)}\n`);
    }

    prompt();
  });
}

prompt();
