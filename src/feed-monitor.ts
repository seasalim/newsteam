/**
 * Feed monitoring & delivery: scheduled feed checks, batched digest
 * delivery at configured times, and manual feed refresh.
 *
 * Extracted from feeds.ts to keep files under 500 lines.
 */

import type { DigestQualityEvaluation } from "./agent.ts";
import type { FeedsConfig } from "./config.ts";
import type { ThinkingLevel } from "./llm-types.ts";
import {
  type DigestMetrics,
  type FeedAgent,
  type FeedBot,
  type FeedLogger,
  enqueueFeedDigestJob,
  selectDigestItems,
} from "./feed-digest.ts";
import {
  type FeedItem,
  appendPendingItems,
  clearPendingItems,
  filterToActiveFeeds,
  getCurrentPacificHour,
  isWithinWakingHours,
  loadActiveFeedIds,
  loadPendingItems,
  runFeedCheckScript,
  savePendingItems,
} from "./feeds.ts";
import type { JobQueue } from "./scheduler.ts";

// ── Types ────────────────────────────────────────────────────────

type FeedCheckResult = {
  new_items?: FeedItem[];
};

type Usage = {
  inputTokens: number;
  outputTokens: number;
  thinkingTokens?: number;
};

export type FeedMonitorCycleOptions = {
  feedsConfig: FeedsConfig;
  jobQueue: JobQueue;
  agent: FeedAgent;
  bot: FeedBot;
  digestModel?: string;
  digestThinkingLevel?: ThinkingLevel;
  log?: FeedLogger;
  checkFeeds?: () => Promise<FeedCheckResult | null>;
  getCurrentPacificHour?: () => number;
  onNarration?: (response: { content: string; usage: Usage }) => void;
  onDigestMetrics?: (metrics: DigestMetrics) => void;
  onDigestQuality?: (evaluation: DigestQualityEvaluation) => void;
  pendingPath?: string;
  feedsPath?: string;
  statePath?: string;
  contextPath?: string;
  interestsPath?: string;
  lensPath?: string;
  archivePath?: string;
  qualityPath?: string;
  sourceReviewPath?: string;
};

// ── Feed monitoring ─────────────────────────────────────────────

export async function runFeedMonitorCycle(options: FeedMonitorCycleOptions): Promise<void> {
  const log = options.log ?? console;
  const currentPacificHourProvider = options.getCurrentPacificHour ?? (() => getCurrentPacificHour());

  try {
    const currentHour = currentPacificHourProvider();

    if (
      !isWithinWakingHours(
        currentHour,
        options.feedsConfig.waking_hours_start,
        options.feedsConfig.waking_hours_end,
      )
    ) {
      return;
    }

    const result = await (options.checkFeeds?.() ?? runFeedCheckScript({
      log,
      feedsPath: options.feedsPath,
      statePath: options.statePath,
    }));
    const allNewItems = Array.isArray(result?.new_items) ? result.new_items : [];

    if (allNewItems.length === 0) {
      return;
    }

    if (options.feedsConfig.digest_times && options.feedsConfig.digest_times.length > 0) {
      // Batched mode: accumulate ALL new items from every feed.
      // The max_items_per_digest cap is applied later at delivery time
      // (in runDigestDelivery) so we don't drop items from lower-priority feeds.
      appendPendingItems(
        allNewItems,
        options.pendingPath,
        {
          feedsPath: options.feedsPath,
          maxQueueAgeHours: options.feedsConfig.max_queue_age_hours,
          maxContentAgeHours: options.feedsConfig.max_content_age_hours,
        },
      );
      const total = loadPendingItems(
        options.pendingPath,
        {
          feedsPath: options.feedsPath,
          maxQueueAgeHours: options.feedsConfig.max_queue_age_hours,
          maxContentAgeHours: options.feedsConfig.max_content_age_hours,
        },
      ).length;
      log.log(`[feeds] Accumulated ${allNewItems.length} items (${total} total pending)`);
    } else {
      // Legacy mode: narrate immediately — cap here since this goes straight to Discord
      const capped = allNewItems.slice(0, options.feedsConfig.max_items_per_digest);
      const accepted = await enqueueFeedDigestJob({
        jobQueue: options.jobQueue,
        items: capped,
        agent: options.agent,
        bot: options.bot,
        channelId: options.feedsConfig.channel_id,
        log,
        digestMaxTurns: options.feedsConfig.digest_max_turns,
        digestModel: options.digestModel,
        digestThinkingLevel: options.digestThinkingLevel,
        contextPath: options.contextPath,
        interestsPath: options.interestsPath,
        lensPath: options.lensPath,
        feedsPath: options.feedsPath,
        archivePath: options.archivePath,
        qualityPath: options.qualityPath,
        sourceReviewPath: options.sourceReviewPath,
        onNarration: options.onNarration,
        onDigestMetrics: options.onDigestMetrics,
        onDigestQuality: options.onDigestQuality,
      });

      if (!accepted) {
        log.log("[feeds] Skipping digest while another job is running");
      }
    }
  } catch (error) {
    log.error("[feeds] Feed monitor tick failed:", error);
  }
}

// ── Digest delivery ─────────────────────────────────────────────

export async function runDigestDelivery(options: {
  feedsConfig: FeedsConfig;
  jobQueue: JobQueue;
  agent: FeedAgent;
  bot: FeedBot;
  digestModel?: string;
  digestThinkingLevel?: ThinkingLevel;
  log?: FeedLogger;
  pendingPath?: string;
  feedsPath?: string;
  contextPath?: string;
  interestsPath?: string;
  lensPath?: string;
  archivePath?: string;
  qualityPath?: string;
  sourceReviewPath?: string;
  onNarration?: (response: { content: string; usage: Usage }) => void;
  onDigestMetrics?: (metrics: DigestMetrics) => void;
  onDigestQuality?: (evaluation: DigestQualityEvaluation) => void;
}): Promise<void> {
  const log = options.log ?? console;
  const activeFeedIds = loadActiveFeedIds(options.feedsPath);
  const rawItems = loadPendingItems(
    options.pendingPath,
    {
      feedsPath: options.feedsPath,
      maxQueueAgeHours: options.feedsConfig.max_queue_age_hours,
      maxContentAgeHours: options.feedsConfig.max_content_age_hours,
    },
  );
  const items = filterToActiveFeeds(rawItems, activeFeedIds);

  // Persist cleanup if stale items were removed
  if (items.length < rawItems.length) {
    log.log(`[feeds] Pruned ${rawItems.length - items.length} items from removed feeds`);
    savePendingItems(items, options.pendingPath);
  }

  if (items.length === 0) {
    log.log("[feeds] Digest time — nothing pending");
    return;
  }

  const maxItems = options.feedsConfig.max_items_per_digest;
  const { selected, remaining } = selectDigestItems(items, maxItems);
  log.log(`[feeds] Digest time — narrating ${selected.length} items (${remaining.length} deferred)`);

  const accepted = await enqueueFeedDigestJob({
    jobQueue: options.jobQueue,
    items: selected,
    agent: options.agent,
    bot: options.bot,
    channelId: options.feedsConfig.channel_id,
    log,
    digestMaxTurns: options.feedsConfig.digest_max_turns,
    digestModel: options.digestModel,
    digestThinkingLevel: options.digestThinkingLevel,
    contextPath: options.contextPath,
    interestsPath: options.interestsPath,
    lensPath: options.lensPath,
    feedsPath: options.feedsPath,
    archivePath: options.archivePath,
    qualityPath: options.qualityPath,
    sourceReviewPath: options.sourceReviewPath,
    onNarration: options.onNarration,
    onDigestMetrics: options.onDigestMetrics,
    onDigestQuality: options.onDigestQuality,
  });

  if (accepted) {
    if (remaining.length > 0) {
      savePendingItems(remaining, options.pendingPath);
    } else {
      clearPendingItems(options.pendingPath);
    }
  } else {
    log.log("[feeds] Digest delivery deferred — job queue busy");
  }
}

// ── Feed refresh (manual trigger) ───────────────────────────────

/**
 * Force a fresh pull of all feeds (ignoring schedules) and deliver immediately.
 * Used by the /refresh slash command.
 */
export async function runFeedRefresh(options: {
  feedsConfig: FeedsConfig;
  jobQueue: JobQueue;
  agent: FeedAgent;
  bot: FeedBot;
  digestModel?: string;
  digestThinkingLevel?: ThinkingLevel;
  log?: FeedLogger;
  pendingPath?: string;
  feedsPath?: string;
  statePath?: string;
  contextPath?: string;
  interestsPath?: string;
  lensPath?: string;
  archivePath?: string;
  qualityPath?: string;
  sourceReviewPath?: string;
  onNarration?: (response: { content: string; usage: Usage }) => void;
  onDigestMetrics?: (metrics: DigestMetrics) => void;
  onDigestQuality?: (evaluation: DigestQualityEvaluation) => void;
}): Promise<{ feedsChecked: number; newItems: number; delivered: boolean }> {
  const log = options.log ?? console;

  // Force check_all: pull every feed regardless of next_due_at
  const result = await runFeedCheckScript({
    log,
    action: "check_all",
    feedsPath: options.feedsPath,
    statePath: options.statePath,
  });

  const freshItems = Array.isArray(result?.new_items) ? result.new_items : [];
  const feedsChecked = (result as Record<string, unknown>)?.feeds_checked as number ?? 0;

  if (freshItems.length === 0) {
    return { feedsChecked, newItems: 0, delivered: false };
  }

  // Merge fresh items with any existing pending items, then deliver
  appendPendingItems(
    freshItems,
    options.pendingPath,
    {
      feedsPath: options.feedsPath,
      maxQueueAgeHours: options.feedsConfig.max_queue_age_hours,
      maxContentAgeHours: options.feedsConfig.max_content_age_hours,
    },
  );

  const activeFeedIds = loadActiveFeedIds(options.feedsPath);
  const rawItems = loadPendingItems(
    options.pendingPath,
    {
      feedsPath: options.feedsPath,
      maxQueueAgeHours: options.feedsConfig.max_queue_age_hours,
      maxContentAgeHours: options.feedsConfig.max_content_age_hours,
    },
  );
  const items = filterToActiveFeeds(rawItems, activeFeedIds);

  const maxItems = options.feedsConfig.max_items_per_digest;
  const { selected, remaining } = selectDigestItems(items, maxItems);

  const accepted = await enqueueFeedDigestJob({
    jobQueue: options.jobQueue,
    items: selected,
    agent: options.agent,
    bot: options.bot,
    channelId: options.feedsConfig.channel_id,
    log,
    digestMaxTurns: options.feedsConfig.digest_max_turns,
    digestModel: options.digestModel,
    digestThinkingLevel: options.digestThinkingLevel,
    contextPath: options.contextPath,
    interestsPath: options.interestsPath,
    lensPath: options.lensPath,
    feedsPath: options.feedsPath,
    archivePath: options.archivePath,
    qualityPath: options.qualityPath,
    sourceReviewPath: options.sourceReviewPath,
    onNarration: options.onNarration,
    onDigestMetrics: options.onDigestMetrics,
    onDigestQuality: options.onDigestQuality,
  });

  if (accepted) {
    if (remaining.length > 0) {
      savePendingItems(remaining, options.pendingPath);
    } else {
      clearPendingItems(options.pendingPath);
    }
  }

  return { feedsChecked, newItems: freshItems.length, delivered: accepted };
}
