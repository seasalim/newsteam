import "dotenv/config";

import path from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";

import { AgentLoop } from "./agent.js";
import { BudgetTracker } from "./budget.js";
import { loadConfig, resolveAgentConfig } from "./config.js";
import { collectDemoSetup } from "./demo-setup.js";
import { ToolExecutor } from "./executor.js";
import {
  buildFeedDigestPrompt,
  type FeedCheckResult,
  loadFeedRegistryMetadata,
  loadInterests,
  loadLens,
  runFeedCheckScript,
  selectDigestItems,
} from "./feeds.js";
import { MemoryManager } from "./memory.js";
import { getModelProvider } from "./model.js";
import { createGeminiClient } from "./provider-gemini.js";
import { ToolRegistry } from "./registry.js";
import { renderTerminalMarkdown } from "./terminal-markdown.js";
import {
  createDemoWorkspace,
  formatDemoError,
} from "./demo-support.js";

const DEMO_TEMPLATE_AGENT_ID = "kingclawd";
const DEMO_CHANNEL_ID = "console";
const DEMO_MAX_ITEMS = 8;
const DEMO_MAX_TURNS = 6;

async function runFollowUpLoop(
  agent: AgentLoop,
  budget: BudgetTracker,
  personaName: string,
): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return;

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let closed = false;
  rl.on("SIGINT", () => {
    closed = true;
    rl.close();
  });

  console.log("\nAsk a follow-up, type /cost, or type /quit.");
  while (!closed) {
    let input: string;
    try {
      input = (await rl.question("You: ")).trim();
    } catch {
      break;
    }
    if (!input) continue;
    if (input === "/quit" || input === "/exit") break;
    if (input === "/cost") {
      console.log(`\n${budget.formatStats()}\n`);
      continue;
    }

    const response = await agent.chat(input, DEMO_CHANNEL_ID, {
      throwOnApiError: true,
    });
    console.log(`\n${personaName}:\n${renderTerminalMarkdown(response.content)}`);
    console.log(`${budget.formatInline()}\n`);
  }

  rl.close();
}

export async function runDemo(projectRoot = process.cwd()): Promise<void> {
  console.log("NewsTeam console demo — no Discord required");
  const setup = await collectDemoSetup(projectRoot);

  const workspace = createDemoWorkspace(projectRoot, { personaId: setup.persona.id });
  const exitOnSignal = (): void => {
    workspace.cleanup();
    process.exit(130);
  };
  process.once("SIGINT", exitOnSignal);
  process.once("SIGTERM", exitOnSignal);
  try {
    const swarmConfig = loadConfig(path.join(projectRoot, "config.example.yaml"));
    const template = swarmConfig.agents.find((agent) => agent.id === DEMO_TEMPLATE_AGENT_ID);
    if (!template?.feeds) {
      throw new Error(`Demo template "${DEMO_TEMPLATE_AGENT_ID}" is missing from config.example.yaml`);
    }

    const agentConfig = {
      ...template,
      id: setup.persona.id,
      persona_dir: workspace.personaDir,
      channel_ids: [DEMO_CHANNEL_ID],
      feeds: {
        ...template.feeds,
        channel_id: DEMO_CHANNEL_ID,
        max_items_per_digest: Math.min(template.feeds.max_items_per_digest, DEMO_MAX_ITEMS),
        digest_times: undefined,
        synthesis_day: undefined,
        synthesis_time: undefined,
      },
    };
    const config = resolveAgentConfig(agentConfig, swarmConfig);
    if (getModelProvider(config.budget.model) !== "google") {
      throw new Error("The console demo requires a Google model in config.example.yaml");
    }

    const toolsDir = path.resolve(projectRoot, config.tools_dir);
    const registry = new ToolRegistry(toolsDir);
    registry.loadAll({ availableSecretsOnly: true });
    const executor = new ToolExecutor(toolsDir);
    const budget = new BudgetTracker(config.budget, setup.persona.id);
    const memory = new MemoryManager(
      path.join(workspace.personaDir, "MEMORY.md"),
      config.memory.max_tokens,
    );
    const agent = new AgentLoop({
      config,
      budget,
      memory,
      llmClient: createGeminiClient(setup.apiKey, config.budget.model),
      registry,
      executor,
      agentId: setup.persona.id,
    });

    console.log(`Persona: ${setup.persona.name}  |  Model: ${config.budget.model}`);
    console.log("Checking the starter feeds...");

    const feedsPath = path.join(workspace.personaDir, "feeds.json");
    const statePath = path.join(workspace.personaDir, "feeds_state.json");
    const checkResult: FeedCheckResult | null = await runFeedCheckScript({
      action: "check_all",
      feedsPath,
      statePath,
      scriptPath: path.join(projectRoot, "scripts", "feed-check.py"),
    });
    const liveItems = Array.isArray(checkResult?.new_items) ? checkResult.new_items : [];
    const { selected } = selectDigestItems(liveItems, agentConfig.feeds.max_items_per_digest);
    if (selected.length === 0) {
      throw new Error("No items were available from the starter feeds. Check your connection and try again.");
    }

    const feedErrors = checkResult?.errors?.length ?? 0;
    console.log(
      `Found ${liveItems.length} new items across ${checkResult?.feeds_checked ?? "the"} feeds` +
      `${feedErrors > 0 ? ` (${feedErrors} feed errors)` : ""}.`,
    );
    console.log(`Generating a briefing from ${selected.length} items...\n`);

    const metadata = loadFeedRegistryMetadata(feedsPath);
    const prompt = buildFeedDigestPrompt(
      selected,
      [],
      loadInterests(path.join(workspace.personaDir, "INTERESTS.md")),
      loadLens(path.join(workspace.personaDir, "LENS.md")),
      metadata,
      { deliveryTarget: "console" },
    );
    const response = await agent.chat(prompt, DEMO_CHANNEL_ID, {
      maxTurns: Math.min(config.feeds?.digest_max_turns ?? DEMO_MAX_TURNS, DEMO_MAX_TURNS),
      model: config.budget.digest_model,
      thinkingLevel: config.budget.digest_thinking_level,
      throwOnApiError: true,
    });

    console.log(renderTerminalMarkdown(response.content));
    console.log(`\n${budget.formatInline()}`);
    await runFollowUpLoop(agent, budget, setup.persona.name);
    memory.flush();
  } finally {
    process.off("SIGINT", exitOnSignal);
    process.off("SIGTERM", exitOnSignal);
    workspace.cleanup();
  }
}

const isMainModule =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMainModule) {
  runDemo().catch((error) => {
    console.error(`\nDemo failed: ${formatDemoError(error)}`);
    process.exitCode = 1;
  });
}
