import "dotenv/config";

// Prepend ISO timestamps to all stdout/stderr console output.
const originalLog = console.log.bind(console);
const originalError = console.error.bind(console);
const originalWarn = console.warn.bind(console);
console.log = (...args: unknown[]) => originalLog(new Date().toISOString(), ...args);
console.error = (...args: unknown[]) => originalError(new Date().toISOString(), ...args);
console.warn = (...args: unknown[]) => originalWarn(new Date().toISOString(), ...args);

import path from "node:path";
import { pathToFileURL } from "node:url";

import type { ConfirmFn } from "./agent.js";
import { createBot } from "./bot.js";
import { loadConfig } from "./config.js";
import { ToolExecutor } from "./executor.js";
import { buildDigestCallbacks, resolveFeedPaths } from "./feed-wiring.js";
import { loadPendingItems, runDigestDelivery, runFeedRefresh } from "./feeds.js";
import { startHeartbeat } from "./heartbeat.js";
import { startDashboard } from "./dashboard.js";
import { EventLogger } from "./logger.js";
import { CostLedger } from "./ledger.js";
import { AgentManager, type AgentInstance } from "./manager.js";
import { ToolRegistry } from "./registry.js";
import { JobQueue } from "./scheduler.js";
import { formatDollarsFromCents } from "./model-cost.js";

async function main(): Promise<void> {
  const swarmConfig = loadConfig();

  // Shared components
  const toolsDir = path.resolve(swarmConfig.tools_dir);
  const logger = new EventLogger();
  const registry = new ToolRegistry(toolsDir);
  registry.loadAll();
  const executor = new ToolExecutor(toolsDir, logger);

  // Single global cost ledger — one source of truth for all spend
  const ledger = new CostLedger();

  // Per-agent job queues and digest state
  const jobQueues = new Map<string, JobQueue>();
  const lastDigests = new Map<string, string | null>();

  // Bot reference — set after creation
  let bot: ReturnType<typeof createBot>;

  // Build confirmFn factory for the manager
  function buildConfirmFn(instance: AgentInstance): ConfirmFn {
    return async (toolName: string, args: Record<string, unknown>, channelId: string): Promise<boolean> => {
      const preview = `**Tool:** \`${toolName}\`\n${Object.entries(args).map(([k, v]) => `**${k}:** ${String(v).slice(0, 200)}`).join("\n")}`;
      const timeoutMs = swarmConfig.confirmation_timeout_ms;
      return bot.requestConfirmation(channelId, preview, timeoutMs);
    };
  }

  // Create the agent manager
  const manager = new AgentManager(swarmConfig, registry, executor, logger, buildConfirmFn);

  const startedAt = new Date();

  // Initialize per-agent job queues
  for (const instance of manager.getAllAgents()) {
    jobQueues.set(instance.id, new JobQueue());
    lastDigests.set(instance.id, null);
  }

  async function resetAgentSession(instance: AgentInstance): Promise<string> {
    const jobQueue = jobQueues.get(instance.id)!;
    const status = jobQueue.getStatus();
    const hasPendingWork = status.running || status.pendingUsers > 0 || status.pendingFeeds > 0;
    const resetJob = jobQueue.enqueue(async () => {
      instance.agentLoop.clearWindow();
      instance.budget.reset();
    }, "user");

    if (hasPendingWork) {
      void resetJob.catch((error) => {
        console.error(`[new] Failed to reset session for ${instance.id}:`, error);
      });
      return `Conversation reset queued for ${instance.id}. It will apply after current work finishes.`;
    }

    await resetJob;
    return `Conversation cleared for ${instance.id}.`;
  }

  // ── Single Discord bot ─────────────────────────────────────────────

  const discordToken = process.env.DISCORD_TOKEN;
  if (!discordToken) {
    throw new Error("DISCORD_TOKEN is required");
  }

  const allChannelIds = manager.getAllChannelIds();

  bot = createBot({
    token: discordToken,
    allowedUserId: swarmConfig.discord.allowed_user_id,
    allowedChannelIds: allChannelIds,
    rateLimitMs: swarmConfig.defaults.conversation.rate_limit_ms,
    onMessage: async (message: string, channelId: string) => {
      const instance = manager.getAgentForChannel(channelId);
      if (!instance) throw new Error(`No agent configured for channel ${channelId}`);
      const jobQueue = jobQueues.get(instance.id)!;
      let combinedResponse = "";
      const accepted = await jobQueue.enqueue(async () => {
        const costBefore = instance.budget.getStats().costCents;
        const response = await instance.agentLoop.chat(message, channelId);
        const costAfter = instance.budget.getStats().costCents;
        combinedResponse = `${response.content}\n───\n🔁 turns: ${response.turns}/${instance.config.budget.max_turns} | ${instance.budget.formatInline()}`;
        ledger.record({
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          costCents: costAfter - costBefore,
          turns: response.turns,
          toolCalls: 0,
          source: "chat",
          agentId: instance.id,
        });
        instance.memory.flush();
      }, "user");
      if (!accepted) {
        throw new Error("User job was not accepted");
      }
      return combinedResponse;
    },
    onStats: (channelId: string) => {
      const instance = manager.getAgentForChannel(channelId);
      if (instance) {
        return `**${instance.id}**\n${instance.budget.formatStats()}`;
      }
      return manager.getAllAgents()
        .map(a => `**${a.id}**\n${a.budget.formatStats()}`)
        .join("\n\n");
    },
    onClear: async (channelId: string) => {
      const instance = manager.getAgentForChannel(channelId);
      if (instance) {
        return resetAgentSession(instance);
      }

      const agents = manager.getAllAgents();
      const resetResults = await Promise.all(agents.map(resetAgentSession));
      if (resetResults.some((result) => result.includes("queued"))) {
        return "Conversation reset queued for all agents. Resets will apply after current work finishes.";
      }
      return "Conversation cleared for all agents.";
    },
    onCost: () => {
      return ledger.formatCostReport(swarmConfig.defaults.budget.monthly_budget_cents);
    },
    onReplay: (channelId: string) => {
      const instance = manager.getAgentForChannel(channelId);
      if (instance) {
        return lastDigests.get(instance.id) ?? null;
      }
      for (const a of manager.getAllAgents()) {
        const digest = lastDigests.get(a.id);
        if (digest) return digest;
      }
      return null;
    },
    onHealth: () => {
      const uptimeMs = Date.now() - startedAt.getTime();
      const uptimeMin = Math.floor(uptimeMs / 60_000);
      const uptimeHours = Math.floor(uptimeMin / 60);
      const uptimeStr = uptimeHours > 0 ? `${uptimeHours}h ${uptimeMin % 60}m` : `${uptimeMin}m`;
      const toolNames = registry.getAll().map(t => t.name).sort();

      const agentLines = manager.getAllAgents().map(a => {
        const stats = a.budget.getStats();
        return `  ${a.id}: $${formatDollarsFromCents(stats.costCents)} | ${a.raw.channel_ids.length} ch`;
      });

      return [
        "Health Check",
        "────────────────────────",
        `Uptime:   ${uptimeStr}`,
        `Agents:   ${manager.getAllAgents().length}`,
        ...agentLines,
        `Tools:    ${toolNames.length > 0 ? toolNames.join(", ") : "none"}`,
      ].join("\n");
    },
    onDigest: async (channelId: string) => {
      const targeted = manager.getAgentForChannel(channelId);
      const agents = targeted ? [targeted] : manager.getAllAgents();

      const results: string[] = [];
      for (const instance of agents) {
        if (!instance.config.feeds?.enabled) continue;
        const paths = resolveFeedPaths(instance.raw.persona_dir);
        const pending = loadPendingItems(
          paths.pendingPath,
          {
            feedsPath: paths.feedsPath,
            maxQueueAgeHours: instance.config.feeds.max_queue_age_hours,
            maxContentAgeHours: instance.config.feeds.max_content_age_hours,
          },
        );
        if (pending.length === 0) {
          results.push(`${instance.id}: no pending items`);
          continue;
        }
        const callbacks = buildDigestCallbacks({ agent: instance, logger, ledger, lastDigests });
        await runDigestDelivery({
          feedsConfig: instance.config.feeds,
          jobQueue: jobQueues.get(instance.id)!,
          agent: instance.agentLoop,
          bot,
          digestModel: instance.config.budget.digest_model,
          digestThinkingLevel: instance.config.budget.digest_thinking_level,
          ...paths,
          ...callbacks,
        });
        results.push(`${instance.id}: digest delivered`);
      }
      return results.length > 0 ? results.join("\n") : "No feeds enabled.";
    },
    onRefresh: async (channelId: string) => {
      const targeted = manager.getAgentForChannel(channelId);
      const agents = targeted ? [targeted] : manager.getAllAgents();

      const results: string[] = [];
      for (const instance of agents) {
        if (!instance.config.feeds?.enabled) continue;
        const paths = resolveFeedPaths(instance.raw.persona_dir);
        const callbacks = buildDigestCallbacks({ agent: instance, logger, ledger, lastDigests });

        const { feedsChecked, newItems, delivered } = await runFeedRefresh({
          feedsConfig: instance.config.feeds,
          jobQueue: jobQueues.get(instance.id)!,
          agent: instance.agentLoop,
          bot,
          digestModel: instance.config.budget.digest_model,
          digestThinkingLevel: instance.config.budget.digest_thinking_level,
          ...paths,
          ...callbacks,
        });

        if (newItems === 0) {
          results.push(`${instance.id}: checked ${feedsChecked} feeds — no new items`);
        } else {
          results.push(`${instance.id}: checked ${feedsChecked} feeds — ${newItems} new items${delivered ? " (delivering)" : " (queued)"}`);
        }
      }
      return results.length > 0 ? results.join("\n") : "No feeds enabled.";
    },
  });

  // ── Login ──────────────────────────────────────────────────────────

  try {
    await bot.login();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[core] Failed to log in bot: ${message}`);
    process.exit(1);
  }

  // ── Dashboard ─────────────────────────────────────────────────────

  const dashboardServer = startDashboard({
    swarmConfig,
    agents: manager.getAllAgents(),
    logger,
    ledger,
    startedAt,
  });

  // ── Central heartbeat (feeds, digests, synthesis, idle) ───────────

  const heartbeat = startHeartbeat({
    agents: manager.getAllAgents(),
    ledger,
    logger,
    bot,
    jobQueues,
    lastDigests,
  });

  // ── Shutdown ──────────────────────────────────────────────────────

  let isShuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log("[core] Shutting down gracefully...");
    clearInterval(heartbeat.interval);
    clearTimeout(heartbeat.initialTimeout);
    manager.shutdown();
    dashboardServer.close();
    await bot.client.destroy();
    console.log("[core] Goodbye.");
    process.exit(0);
  };

  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());

  // ── Startup log ───────────────────────────────────────────────────

  const toolNames = registry.getAll().map((tool) => tool.name).sort();
  console.log("[core] Newsteam swarm online");
  console.log("[core]   Agents:");
  for (const agent of manager.getAllAgents()) {
    const channelCount = agent.raw.channel_ids.length;
    const feedStatus = agent.config.feeds?.enabled ? "enabled" : "disabled";
    const channels = channelCount === 1 ? "channel" : "channels";
    console.log(`[core]     ${agent.id}: feeds ${feedStatus}, ${channelCount} ${channels}`);
  }
  console.log(`[core]   Tools: ${toolNames.join(", ") || "none"}`);
}

const isMainModule =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMainModule) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[core] Failed to start Newsteam: ${message}`);
    process.exit(1);
  });
}
