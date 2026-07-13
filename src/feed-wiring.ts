/**
 * Shared helpers for wiring up feed digest/synthesis calls.
 * Eliminates repeated path resolution and callback construction
 * across heartbeat.ts and index.ts.
 */

import fs from "node:fs";
import path from "node:path";

import type { DigestQualityEvaluation } from "./agent.js";
import type { CostLedger } from "./ledger.js";
import type { EventLogger } from "./logger.js";
import type { AgentInstance } from "./manager.js";
import type { DigestMetrics, SynthesisMetrics } from "./feeds.js";

// ── Persona-relative path resolution ────────────────────────────────

export interface FeedPaths {
  pendingPath: string;
  feedsPath: string;
  statePath: string;
  contextPath: string;
  interestsPath: string;
  lensPath: string;
  archivePath: string;
  qualityPath: string;
  sourceReviewPath: string;
}

export function resolveFeedPaths(personaDir: string): FeedPaths {
  return {
    pendingPath: path.resolve(personaDir, "feeds_pending.json"),
    feedsPath: path.resolve(personaDir, "feeds.json"),
    statePath: path.resolve(personaDir, "feeds_state.json"),
    contextPath: path.resolve(personaDir, "feed_context.json"),
    interestsPath: path.resolve(personaDir, "INTERESTS.md"),
    lensPath: path.resolve(personaDir, "LENS.md"),
    archivePath: path.resolve(personaDir, "digest_archive.json"),
    qualityPath: path.resolve(personaDir, "digest_quality.jsonl"),
    sourceReviewPath: path.resolve(personaDir, "feed_source_review.json"),
  };
}

export function getFeedStartupWarning(options: {
  agentId: string;
  feedsEnabled: boolean;
  personaDir: string;
}): string | null {
  if (!options.feedsEnabled) return null;

  const personaDir = path.resolve(options.personaDir);
  if (!fs.existsSync(personaDir)) {
    return `${options.agentId}: feeds enabled but persona directory is missing: ${personaDir}`;
  }

  const feedsPath = path.join(personaDir, "feeds.json");
  if (!fs.existsSync(feedsPath)) {
    return `${options.agentId}: feeds enabled but feeds.json is missing: ${feedsPath}`;
  }

  let feedCount = 0;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(feedsPath, "utf-8"));
    if (Array.isArray(parsed)) {
      feedCount = parsed.filter((entry) => (
        typeof entry === "object" &&
        entry !== null &&
        "id" in entry &&
        typeof entry.id === "string" &&
        entry.id.length > 0
      )).length;
    }
  } catch {
    // Invalid or unreadable registries contain no usable feeds.
  }

  if (feedCount === 0) {
    return `${options.agentId}: feeds enabled but no valid feeds are configured in ${feedsPath}`;
  }

  return null;
}

// ── Callback factories ──────────────────────────────────────────────

type Usage = { inputTokens: number; outputTokens: number };

export interface DigestCallbacks {
  onNarration: (response: { content: string; usage: Usage }) => void;
  onDigestMetrics: (metrics: DigestMetrics) => void;
  onDigestQuality: (evaluation: DigestQualityEvaluation) => void;
}

export function buildDigestCallbacks(options: {
  agent: AgentInstance;
  logger: EventLogger;
  ledger: CostLedger;
  lastDigests: Map<string, string | null>;
}): DigestCallbacks {
  const { agent, logger, ledger, lastDigests } = options;

  return {
    onNarration: (response) => {
      lastDigests.set(agent.id, response.content);
      agent.memory.flush();
    },
    onDigestMetrics: (metrics: DigestMetrics) => {
      logger.emit("feed.digest.metrics", { agent_id: agent.id, ...metrics });
      ledger.record({
        inputTokens: metrics.input_tokens,
        outputTokens: metrics.output_tokens,
        costCents: metrics.cost_cents,
        turns: metrics.turns_used,
        toolCalls: metrics.tool_calls,
        source: "digest",
        agentId: agent.id,
      });
    },
    onDigestQuality: (evaluation: DigestQualityEvaluation) => {
      logger.emit("feed.digest.quality", { agent_id: agent.id, ...evaluation });
      ledger.record({
        inputTokens: evaluation.input_tokens,
        outputTokens: evaluation.output_tokens,
        costCents: evaluation.cost_cents,
        turns: 1,
        toolCalls: 0,
        source: "digest_eval",
        agentId: agent.id,
      });
    },
  };
}

export function recordSynthesisCost(options: {
  metrics: SynthesisMetrics;
  agentId: string;
  logger: EventLogger;
  ledger: CostLedger;
}): void {
  options.logger.emit("feed.synthesis.metrics", { agent_id: options.agentId, ...options.metrics });
  options.ledger.record({
    inputTokens: options.metrics.input_tokens,
    outputTokens: options.metrics.output_tokens,
    costCents: options.metrics.cost_cents,
    turns: 1,
    toolCalls: 0,
    source: "synthesis",
    agentId: options.agentId,
  });
}
