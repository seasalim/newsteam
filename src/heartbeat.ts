import type { CostLedger } from "./ledger.js";
import type { EventLogger } from "./logger.js";
import type { AgentInstance } from "./manager.js";
import { buildDigestCallbacks, recordSynthesisCost, resolveFeedPaths } from "./feed-wiring.js";
import { type SynthesisMetrics, PACIFIC_TIME_ZONE, isDigestTime, isSynthesisTime, loadPendingItems, runDigestDelivery, runFeedMonitorCycle, runWeeklySynthesis } from "./feeds.js";
import { JobQueue } from "./scheduler.js";

export interface HeartbeatOptions {
  agents: AgentInstance[];
  ledger: CostLedger;
  logger: EventLogger;
  bot: { sendToChannel: (channelId: string, text: string) => Promise<void> };
  jobQueues: Map<string, JobQueue>;
  lastDigests: Map<string, string | null>;
}

interface AgentTickState {
  lastPollAt: number;
  lastDigestMinute: string;
  lastSynthesisMinute: string;
  feedTickInFlight: boolean;
}

/**
 * Start a single 60-second heartbeat that drives all agent scheduling:
 * feed polling, digest delivery, weekly synthesis, and idle checks.
 */
export function startHeartbeat(options: HeartbeatOptions): { interval: ReturnType<typeof setInterval>; initialTimeout: ReturnType<typeof setTimeout> } {
  const state = new Map<string, AgentTickState>();

  for (const agent of options.agents) {
    state.set(agent.id, {
      lastPollAt: 0,
      lastDigestMinute: "",
      lastSynthesisMinute: "",
      feedTickInFlight: false,
    });
  }

  function runFeedPollForAgent(agent: AgentInstance, agentState: AgentTickState): void {
    const feedsConfig = agent.config.feeds;
    if (!feedsConfig?.enabled) return;

    agentState.feedTickInFlight = true;
    agentState.lastPollAt = Date.now();

    const paths = resolveFeedPaths(agent.raw.persona_dir);
    const callbacks = buildDigestCallbacks({ agent, logger: options.logger, ledger: options.ledger, lastDigests: options.lastDigests });

    // Use runFeedMonitorCycle — the normal incremental polling path.
    // It handles waking hours, accumulates pending items for digest_times
    // batching, and only narrates immediately in legacy (non-batched) mode.
    void runFeedMonitorCycle({
      feedsConfig,
      jobQueue: options.jobQueues.get(agent.id)!,
      agent: agent.agentLoop,
      bot: options.bot,
      digestModel: agent.config.budget.digest_model,
      digestThinkingLevel: agent.config.budget.digest_thinking_level,
      ...paths,
      ...callbacks,
    }).finally(() => {
      agentState.feedTickInFlight = false;
    });
  }

  function checkDigestForAgent(agent: AgentInstance, agentState: AgentTickState): void {
    const feedsConfig = agent.config.feeds;
    if (!feedsConfig?.digest_times?.length) return;

    const pacificTime = getCurrentPacificTimeStr();
    if (pacificTime === agentState.lastDigestMinute) return;

    if (isDigestTime(feedsConfig.digest_times)) {
      agentState.lastDigestMinute = pacificTime;

      const paths = resolveFeedPaths(agent.raw.persona_dir);
      const pending = loadPendingItems(
        paths.pendingPath,
        {
          feedsPath: paths.feedsPath,
          maxQueueAgeHours: feedsConfig.max_queue_age_hours,
          maxContentAgeHours: feedsConfig.max_content_age_hours,
        },
      );
      if (pending.length === 0) {
        console.log(`[heartbeat] ${agent.id}: digest time — nothing pending`);
        return;
      }

      console.log(`[heartbeat] ${agent.id}: digest time — delivering`);
      const callbacks = buildDigestCallbacks({ agent, logger: options.logger, ledger: options.ledger, lastDigests: options.lastDigests });

      void runDigestDelivery({
        feedsConfig,
        jobQueue: options.jobQueues.get(agent.id)!,
        agent: agent.agentLoop,
        bot: options.bot,
        digestModel: agent.config.budget.digest_model,
        digestThinkingLevel: agent.config.budget.digest_thinking_level,
        ...paths,
        ...callbacks,
      });
    }
  }

  function checkSynthesisForAgent(agent: AgentInstance, agentState: AgentTickState): void {
    const feedsConfig = agent.config.feeds;
    if (feedsConfig?.synthesis_day === undefined || !feedsConfig?.synthesis_time) return;

    const pacificTime = getCurrentPacificTimeStr();
    if (pacificTime === agentState.lastSynthesisMinute) return;

    if (isSynthesisTime(feedsConfig.synthesis_day, feedsConfig.synthesis_time)) {
      agentState.lastSynthesisMinute = pacificTime;

      console.log(`[heartbeat] ${agent.id}: weekly synthesis time`);
      const paths = resolveFeedPaths(agent.raw.persona_dir);
      void runWeeklySynthesis({
        feedsConfig,
        jobQueue: options.jobQueues.get(agent.id)!,
        agent: agent.agentLoop,
        bot: options.bot,
        digestModel: agent.config.budget.digest_model,
        archivePath: paths.archivePath,
        interestsPath: paths.interestsPath,
        lensPath: paths.lensPath,
        maxInputTokens: agent.config.budget.max_input_tokens,
        onSynthesis: () => {
          agent.memory.flush();
        },
        onSynthesisMetrics: (metrics: SynthesisMetrics) => {
          recordSynthesisCost({ metrics, agentId: agent.id, logger: options.logger, ledger: options.ledger });
        },
      });
    }
  }

  function checkIdleForAgent(agent: AgentInstance): void {
    const idleTimeout = agent.config.conversation.idle_timeout_minutes;
    if (!idleTimeout) return;

    const result = agent.agentLoop.checkIdleAndClear(idleTimeout);
    if (result.wasIdle) {
      console.log(`[heartbeat] ${agent.id}: cleared after ${result.idleMinutes}m idle`);
      options.logger.emit("agent.idle.cleared", { agent_id: agent.id, idle_minutes: result.idleMinutes });
      agent.budget.reset();
    }
  }

  function tick(): void {
    for (const agent of options.agents) {
      const feedsConfig = agent.config.feeds;
      if (!feedsConfig?.enabled) continue;

      const agentState = state.get(agent.id)!;

      // Feed polling: check if enough time has elapsed since last poll
      const pollIntervalMs = feedsConfig.check_interval_minutes * 60_000;
      if (!agentState.feedTickInFlight && Date.now() - agentState.lastPollAt >= pollIntervalMs) {
        runFeedPollForAgent(agent, agentState);
      }

      // Digest delivery
      checkDigestForAgent(agent, agentState);

      // Weekly synthesis
      checkSynthesisForAgent(agent, agentState);
    }

    // Idle checks (all agents, not just feed-enabled)
    for (const agent of options.agents) {
      checkIdleForAgent(agent);
    }
  }

  // Log enabled schedules
  for (const agent of options.agents) {
    const feedsConfig = agent.config.feeds;
    if (!feedsConfig?.enabled) continue;
    console.log(`[heartbeat] ${agent.id}: polling every ${feedsConfig.check_interval_minutes}m`);
    if (feedsConfig.digest_times?.length) {
      console.log(`[heartbeat] ${agent.id}: digests at ${feedsConfig.digest_times.join(", ")} PT`);
    }
    if (feedsConfig.synthesis_day !== undefined && feedsConfig.synthesis_time) {
      const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
      console.log(`[heartbeat] ${agent.id}: synthesis ${dayNames[feedsConfig.synthesis_day]} at ${feedsConfig.synthesis_time} PT`);
    }
  }

  // Initial feed check 30s after startup
  const initialTimeout = setTimeout(() => {
    for (const agent of options.agents) {
      const agentState = state.get(agent.id)!;
      if (agent.config.feeds?.enabled) {
        runFeedPollForAgent(agent, agentState);
      }
    }
  }, 30_000);

  // Main heartbeat: every 60 seconds
  const interval = setInterval(tick, 60_000);

  return { interval, initialTimeout };
}

// ── Time helpers ──────────────────────────────────────────────────

function getCurrentPacificTimeStr(): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "numeric",
    hour12: false,
    timeZone: PACIFIC_TIME_ZONE,
  }).format(new Date());
}
