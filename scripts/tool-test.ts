#!/usr/bin/env node --experimental-strip-types
/**
 * Test the full agent loop with tools. Requires ANTHROPIC_API_KEY in .env.
 * Run: node --experimental-strip-types scripts/tool-test.ts
 */
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
console.log(`🔧 Loaded tools: ${registry.getAll().map(t => t.name).join(", ") || "none"}`);

const executor = new ToolExecutor(cfg.tools_dir);
const agent = new AgentLoop({ config: cfg, budget, memory, registry, executor });

console.log("🦞 Sending: 'Search for the best lobster recipes'\n");

const response = await agent.chat("Search for the best lobster recipes");

console.log(`Agent: ${response.content}\n`);
console.log(budget.formatInline());
console.log(`\n📊 Full stats:\n${budget.formatStats()}`);
