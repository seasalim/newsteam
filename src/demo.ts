import "dotenv/config";

import { execFile } from "node:child_process";
import type http from "node:http";
import path from "node:path";
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
import { createLocalChannelAdapter, type LocalChannelAdapter } from "./local-channel.js";
import { LOCAL_CHANNEL_PAGE } from "./local-channel-page.js";
import { startChatServer } from "./dashboard.js";
import {
  createDemoWorkspace,
  formatDemoError,
} from "./demo-support.js";

const DEMO_TEMPLATE_AGENT_ID = "kingclawd";
const DEMO_CHANNEL_ID = "demo";
const DEMO_MAX_ITEMS = 8;
const DEMO_MAX_TURNS = 6;

function openBrowser(url: string): void {
  const command = process.platform === "darwin"
    ? { file: "open", args: [url] }
    : process.platform === "win32"
      ? { file: "cmd", args: ["/c", "start", "", url] }
      : { file: "xdg-open", args: [url] };
  execFile(command.file, command.args, () => {});
}

async function waitForListening(server: http.Server): Promise<void> {
  if (server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
}

async function closeServer(server: http.Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

export async function runDemo(projectRoot = process.cwd()): Promise<void> {
  console.log("NewsTeam local demo — no Discord required");
  const setup = await collectDemoSetup(projectRoot);

  const workspace = createDemoWorkspace(projectRoot, { personaId: setup.persona.id });
  let requestShutdown!: () => void;
  const shutdownRequested = new Promise<void>((resolve) => { requestShutdown = resolve; });
  const exitOnSignal = (): void => requestShutdown();
  process.once("SIGINT", exitOnSignal);
  process.once("SIGTERM", exitOnSignal);
  let adapter: LocalChannelAdapter | undefined;
  let server: http.Server | undefined;
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
      throw new Error("The local demo requires a Google model in config.example.yaml");
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
      confirmFn: async (toolName, args, channelId) => {
        const preview = `**Tool:** \`${toolName}\`\n${Object.entries(args).map(([key, value]) => `**${key}:** ${String(value).slice(0, 200)}`).join("\n")}`;
        return adapter?.requestConfirmation(channelId, preview, 120_000) ?? false;
      },
    });

    adapter = createLocalChannelAdapter({
      channels: [{
        channel_id: DEMO_CHANNEL_ID,
        agent_id: setup.persona.id,
        is_feed_channel: true,
        persona_dir: workspace.personaDir,
      }],
      rateLimitMs: config.conversation.rate_limit_ms,
      pageHtml: LOCAL_CHANNEL_PAGE,
      onMessage: async (message, channelId) => {
        const result = await agent.chat(message, channelId, { throwOnApiError: true });
        memory.flush();
        return `${result.content}\n───\n${budget.formatInline()}`;
      },
      onStats: () => budget.formatStats(),
      onClear: () => {
        agent.clearWindow();
        budget.reset();
        return `Conversation cleared for ${setup.persona.name}.`;
      },
      onCost: () => budget.formatStats(),
      onHealth: () => "Demo is running locally.",
    });
    await adapter.start();
    const demoHost = process.env.DASHBOARD_HOST ?? "127.0.0.1";
    const demoToken = process.env.LOCAL_CHANNEL_TOKEN?.trim() || undefined;
    if (!["127.0.0.1", "::1", "localhost"].includes(demoHost) && !demoToken) {
      console.warn("WARNING: local demo is bound to a non-loopback host without LOCAL_CHANNEL_TOKEN");
    }
    server = startChatServer([adapter.handleRequest], {
      host: demoHost,
      port: 7777,
      token: demoToken,
    });
    await waitForListening(server);
    const demoUrl = `http://127.0.0.1:7777/chat${demoToken ? `?token=${encodeURIComponent(demoToken)}` : ""}`;
    console.log(`Demo running — open ${demoUrl}`);
    openBrowser(demoUrl);

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
    );
    const response = await agent.chat(prompt, DEMO_CHANNEL_ID, {
      maxTurns: Math.min(config.feeds?.digest_max_turns ?? DEMO_MAX_TURNS, DEMO_MAX_TURNS),
      model: config.budget.digest_model,
      thinkingLevel: config.budget.digest_thinking_level,
      throwOnApiError: true,
    });

    await adapter.sendToChannel(
      DEMO_CHANNEL_ID,
      `${response.content}\n───\n${budget.formatInline()}`,
    );
    console.log("Briefing ready in local chat. Press Ctrl-C to stop the demo.");
    await shutdownRequested;
    memory.flush();
  } finally {
    process.off("SIGINT", exitOnSignal);
    process.off("SIGTERM", exitOnSignal);
    if (adapter) await adapter.stop();
    if (server) await closeServer(server);
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
