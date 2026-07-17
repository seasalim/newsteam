/**
 * Feed digest: prompt building, item selection, metrics collection,
 * and the core digest job orchestration (enqueueFeedDigestJob).
 *
 * Extracted from feeds.ts to keep files under 500 lines.
 */

import fs from "node:fs";
import path from "node:path";

import type { DigestQualityEvaluation } from "./agent.ts";
import type { FeedsConfig } from "./config.ts";
import type { DigestQualityMetrics } from "./digest-metrics.ts";
import type { ThinkingLevel } from "./llm-types.ts";
import {
  type FeedContextEntry,
  appendDigestArchive,
  buildContextSection,
  buildInterestsSection,
  buildLensSection,
  loadFeedContext,
  loadInterests,
  loadLens,
  saveFeedContext,
} from "./feed-context.ts";
import {
  buildFetchGuidanceSection,
  buildItemFetchHintLine,
  buildLargeDigestFetchSection,
  isLargeDigestZeroFetch,
  sanitizeFeedUrl,
} from "./feed-fetch-guidance.ts";
import { updateFeedSourceReview } from "./feed-review.ts";
import {
  type FeedFetchHint,
  type FeedItem,
  type FeedRegistryMetadata,
  loadFeedRegistryMetadata,
  normalizeComparableUrl,
  sanitizeFeedText,
} from "./feeds.ts";
import type { JobQueue } from "./scheduler.ts";

// ── Types ────────────────────────────────────────────────────────

type Usage = {
  inputTokens: number;
  outputTokens: number;
  thinkingTokens?: number;
};

export type FeedAgent = {
  chat: (message: string, channelId?: string, options?: { maxTurns?: number; model?: string; thinkingLevel?: ThinkingLevel }) => Promise<{ content: string; usage: Usage }>;
  clearWindow: () => void;
  getBudgetStats?: () => { toolCalls: number; toolUsage: Record<string, number>; costCents: number; turns: number };
  getLastToolCalls?: () => Array<{ name: string; args: Record<string, unknown> }>;
  evaluateDigestQuality?: (input: {
    digestText: string;
    items: FeedItem[];
    metrics: DigestQualityMetrics;
    model?: string;
    thinkingLevel?: ThinkingLevel;
  }) => Promise<DigestQualityEvaluation | null>;
  extractDigestContext?: (digestText: string, options?: { model?: string; thinkingLevel?: ThinkingLevel }) => Promise<FeedContextEntry | null>;
};

export type FeedBot = {
  sendToChannel: (channelId: string, text: string) => Promise<void>;
};

export type FeedLogger = Pick<Console, "log" | "error">;

export type DigestMetrics = {
  items_offered: number;
  feed_ids: string[];
  items_fetched: number;
  large_digest_zero_fetch: boolean;
  fetched_feed_ids: string[];
  fetch_hint_counts: Record<FeedFetchHint, number>;
  turns_used: number;
  tool_calls: number;
  tools_used: Record<string, number>;
  input_tokens: number;
  output_tokens: number;
  thinking_tokens?: number;
  cost_cents: number;
  response_length: number;
  model?: string;
  interests_served?: string[];
};

// ── Digest item selection ────────────────────────────────────────

export function selectDigestItems(items: FeedItem[], maxItems: number): { selected: FeedItem[]; remaining: FeedItem[] } {
  if (items.length <= maxItems) {
    return { selected: [...items], remaining: [] };
  }

  // Group items by feed, preserving insertion order within each feed
  const buckets = new Map<string, FeedItem[]>();
  for (const item of items) {
    const key = item.feed_id ?? item.feed_name ?? "unknown";
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.push(item);
    } else {
      buckets.set(key, [item]);
    }
  }

  // Round-robin across feeds so every source gets representation
  const selected: FeedItem[] = [];
  const selectedSet = new Set<number>();
  const feedQueues = [...buckets.values()].map((b) => ({ items: b, index: 0 }));

  while (selected.length < maxItems && feedQueues.some((q) => q.index < q.items.length)) {
    for (const queue of feedQueues) {
      if (selected.length >= maxItems) break;
      if (queue.index < queue.items.length) {
        const item = queue.items[queue.index];
        selected.push(item);
        selectedSet.add(items.indexOf(item));
        queue.index++;
      }
    }
  }

  const remaining = items.filter((_, i) => !selectedSet.has(i));
  return { selected, remaining };
}

// ── Digest prompt building ───────────────────────────────────────

export function buildFeedDigestPrompt(
  items: FeedItem[],
  context?: FeedContextEntry[],
  interests?: string,
  lens?: string,
  feedMetadata?: ReadonlyMap<string, FeedRegistryMetadata>,
): string {
  const sections = items.map((item) => {
    const lines = [
      "---",
      `[${sanitizeFeedText(item.feed_name, "Unknown Feed")}] ${sanitizeFeedText(item.title, "Untitled")}`,
      sanitizeFeedUrl(item.url),
    ];
    const snippet = sanitizeFeedText(item.snippet, "");

    if (snippet.length > 0) {
      lines.push(snippet);
    } else {
      lines.push("Snippet unavailable; title only.");
    }

    const fetchHintLine = buildItemFetchHintLine(item, feedMetadata);
    if (fetchHintLine) {
      lines.push(fetchHintLine);
    }

    lines.push("---");
    return lines.join("\n");
  });

  const contextSection = buildContextSection(context ?? []);
  const interestsSection = buildInterestsSection(interests ?? "");
  const lensSection = buildLensSection(lens ?? "");
  const fetchGuidanceSection = buildFetchGuidanceSection(items, feedMetadata);
  const largeDigestFetchSection = buildLargeDigestFetchSection(items, feedMetadata);
  const deliveryInstruction = "Your reply will be delivered DIRECTLY to the news channel as-is. Every word you write will be seen by the audience.";

  const defaultStyle = [
    "## Style guidelines",
    "- Group related items thematically — connect threads, note trends, surface patterns.",
    "- Have opinions. Don't just summarize — react, contextualize, predict.",
    "- Use readable Markdown and concise paragraphs that work well in chat.",
    "- It's OK to skip low-value items entirely. Curation > completeness.",
  ];

  return [
    "Here are fresh items from your feeds that came in recently.",
    "",
    ...(lensSection ? [lensSection] : []),
    ...(interestsSection ? [interestsSection] : []),
    ...(contextSection ? [contextSection] : []),
    "## Your task",
    "Write a casual, opinionated digest — NOT a weekly summary, just a quick rundown of what's new right now.",
    deliveryInstruction,
    "",
    "## CRITICAL: No preamble or thinking out loud",
    "Do NOT include any stream-of-consciousness, internal reasoning, or meta-commentary like:",
    '- "Let me scan these and pull out what matters..."',
    '- "Okay, good signal. Let me write this up:"',
    '- "Looking at these items..."',
    '- "Here\'s what I found interesting:"',
    "Your output IS the briefing. Start it immediately. Open with a short, punchy persona-appropriate greeting or quip that ties into today's themes, then go straight into the digest.",
    "",
    "## How to approach this",
    "1. **Scan & triage**: Read all the items below. Score each against your interests above. High-relevance items (★★★) deserve deep analysis. Low-relevance items (★) get a brief mention or are skipped entirely.",
    "2. **Deep-dive selectively**: Follow any feed-specific fetch hints below. For the 1-3 items that score highest on your interests, use the `web_fetch` tool to read the full article. If a feed is marked `always`, fetch before making strong claims. If a feed is marked `never`, only fetch when the item is unusually important or still unclear. Do NOT fetch everything — only items where the snippet alone isn't enough to form an informed take.",
    "3. **Write the digest**: Lead with what matters most. For items you fetched, provide real analysis through your analytical lens — what it means, why it matters, what it connects to. For the rest, brief mentions with links are fine. Skip items that are genuinely uninteresting or outside your domain.",
    "",
    "## CRITICAL: Links",
    "Include the source link for every item you mention, regardless of your digest style — readers must be able to click through to the original article. Use the item's URL exactly as provided below; never invent or reconstruct URLs.",
    "",
    "## CRITICAL: Accuracy",
    "You are working from short snippets, NOT full articles. Do NOT fabricate or embellish specific details (numbers, quotes, claims) that are not explicitly stated in the snippet or a fetched article. If a snippet is ambiguous, either fetch the full article before making claims, or keep your summary vague enough to match what you actually know. Getting a detail wrong destroys credibility. When in doubt, hedge or fetch — never guess.",
    "Do NOT turn timing or surrounding context into causation. Words like 'amid', 'during', or 'as X happens' do not prove that X caused Y.",
    "Do NOT attribute motives, reasons, or direct second-order effects unless the snippet or fetched article says so clearly. Phrases like 'driven by', 'because of', 'forced by', 'proof that', or 'directly attributed to' require explicit support.",
    "If you want to use a business, tourism, sports, or culture item as evidence of wider economic fallout or strategic impact, fetch it first or describe it narrowly and cautiously.",
    "Keep source facts siloed. Never import a codename, weapon, method, quote, casualty count, or motive from one article into another article's event unless a source explicitly connects them.",
    "If you fetched a general analysis or commentary piece, do NOT use it as factual evidence for a separate news event unless the fetched text directly discusses that event.",
    "When a section cites multiple links, every strong factual claim in that section must be traceable to at least one of those same links. Do not blend unrelated articles into a single narrative sentence.",
    "",
    ...(lensSection ? [] : defaultStyle),
    "",
    ...(largeDigestFetchSection ? [largeDigestFetchSection, ""] : []),
    ...(fetchGuidanceSection ? [fetchGuidanceSection, ""] : []),
    ...sections,
  ].join("\n");
}

// ── Digest metrics helpers ───────────────────────────────────────

export function collectFetchedItems(
  items: FeedItem[],
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>,
): FeedItem[] {
  const fetchedUrls = new Set(
    toolCalls
      .filter((call) => call.name === "web_fetch")
      .map((call) => typeof call.args.url === "string" ? normalizeComparableUrl(call.args.url) : "")
      .filter((url) => url.length > 0),
  );

  if (fetchedUrls.size === 0) return [];

  const matched: FeedItem[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    const normalizedItemUrl = normalizeComparableUrl(item.url);
    if (!normalizedItemUrl || !fetchedUrls.has(normalizedItemUrl) || seen.has(normalizedItemUrl)) {
      continue;
    }

    matched.push(item);
    seen.add(normalizedItemUrl);
  }

  return matched;
}

function buildFetchHintCounts(
  items: FeedItem[],
  feedMetadata: ReadonlyMap<string, FeedRegistryMetadata>,
): Record<FeedFetchHint, number> {
  const counts: Record<FeedFetchHint, number> = {
    auto: 0,
    always: 0,
    never: 0,
  };

  for (const item of items) {
    const hint = item.feed_id ? (feedMetadata.get(item.feed_id)?.fetchHint ?? "auto") : "auto";
    counts[hint] += 1;
  }

  return counts;
}

function appendJsonLine(filePath: string, value: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, "utf-8");
}

// ── Digest job orchestration ─────────────────────────────────────

export async function enqueueFeedDigestJob(options: {
  jobQueue: JobQueue;
  items: FeedItem[];
  agent: FeedAgent;
  bot: FeedBot;
  channelId: string;
  log?: FeedLogger;
  digestMaxTurns?: number;
  digestModel?: string;
  digestThinkingLevel?: ThinkingLevel;
  contextPath?: string;
  interestsPath?: string;
  lensPath?: string;
  feedsPath?: string;
  archivePath?: string;
  qualityPath?: string;
  sourceReviewPath?: string;
  onNarration?: (response: { content: string; usage: Usage }) => void;
  onDigestMetrics?: (metrics: DigestMetrics) => void;
  onDigestQuality?: (evaluation: DigestQualityEvaluation) => void;
}): Promise<boolean> {
  const log = options.log ?? console;
  const context = options.contextPath ? loadFeedContext(options.contextPath) : [];
  const interests = options.interestsPath ? loadInterests(options.interestsPath) : "";
  const lens = options.lensPath ? loadLens(options.lensPath) : "";
  const feedMetadata = options.feedsPath ? loadFeedRegistryMetadata(options.feedsPath) : new Map<string, FeedRegistryMetadata>();
  const prompt = buildFeedDigestPrompt(options.items, context, interests, lens, feedMetadata);
  const maxTurns = options.digestMaxTurns ?? 10;
  const digestModel = options.digestModel;
  const digestThinkingLevel = options.digestThinkingLevel;

  return options.jobQueue.enqueue(async () => {
    let narration: { content: string; usage: Usage };
    let digestMetrics: DigestMetrics | undefined;

    // Snapshot budget stats before digest to compute delta
    const statsBefore = options.agent.getBudgetStats?.();

    // Clear prior conversation so the bot only sees the current digest items,
    // not stale articles from previous runs.
    options.agent.clearWindow();

    try {
      narration = await options.agent.chat(prompt, options.channelId, {
        maxTurns,
        model: digestModel,
        thinkingLevel: digestThinkingLevel,
      });
    } catch (error) {
      log.error("[feeds] agent.chat failed during narration:", error);
      return;
    }

    // Compute and emit digest metrics
    const statsAfter = options.agent.getBudgetStats?.();
    if (statsBefore && statsAfter) {
      const toolsDelta: Record<string, number> = {};
      for (const [tool, count] of Object.entries(statsAfter.toolUsage)) {
        const delta = count - (statsBefore.toolUsage[tool] ?? 0);
        if (delta > 0) toolsDelta[tool] = delta;
      }
      // Extract context from the digest for future continuity
      let interestsServed: string[] | undefined;
      if (options.contextPath && options.agent.extractDigestContext) {
        try {
          const entry = await options.agent.extractDigestContext(narration.content, {
            model: digestModel,
            thinkingLevel: digestThinkingLevel,
          });
          if (entry) {
            const updated = [...context, entry];
            saveFeedContext(options.contextPath, updated);
            interestsServed = entry.interests_served;
            log.log(`[feeds] Feed context updated: ${entry.topics.length} topics, ${entry.entities.length} entities, sentiment=${entry.sentiment}, interests=[${(entry.interests_served ?? []).join(", ")}]`);

            // Append to digest archive for weekly synthesis
            if (options.archivePath) {
              try {
                appendDigestArchive(options.archivePath, {
                  timestamp: entry.timestamp,
                  digest_text: narration.content,
                  context: entry,
                  items_offered: options.items.length,
                  feed_ids: [...new Set(options.items.map(i => i.feed_id ?? "unknown"))],
                });
                log.log(`[feeds] Digest archived for synthesis`);
              } catch (archiveError) {
                log.error("[feeds] Failed to save digest archive:", archiveError);
              }
            }
          }
        } catch (error) {
          log.error("[feeds] Failed to extract/save digest context:", error);
        }
      }

      const fetchedItems = collectFetchedItems(options.items, options.agent.getLastToolCalls?.() ?? []);
      const largeDigestZeroFetch = isLargeDigestZeroFetch(options.items.length, fetchedItems.length);
      digestMetrics = {
        items_offered: options.items.length,
        feed_ids: [...new Set(options.items.map(i => i.feed_id ?? "unknown"))],
        items_fetched: fetchedItems.length,
        large_digest_zero_fetch: largeDigestZeroFetch,
        fetched_feed_ids: [...new Set(fetchedItems.map((item) => item.feed_id ?? "unknown"))],
        fetch_hint_counts: buildFetchHintCounts(fetchedItems, feedMetadata),
        turns_used: statsAfter.turns - statsBefore.turns,
        tool_calls: statsAfter.toolCalls - statsBefore.toolCalls,
        tools_used: toolsDelta,
        input_tokens: narration.usage.inputTokens,
        output_tokens: narration.usage.outputTokens,
        thinking_tokens: narration.usage.thinkingTokens,
        cost_cents: statsAfter.costCents - statsBefore.costCents,
        response_length: narration.content.length,
        model: digestModel,
        interests_served: interestsServed,
      };
      log.log(`[feeds] Digest metrics: ${digestMetrics.items_offered} items, ${digestMetrics.items_fetched} fetched, ${digestMetrics.tool_calls} tool calls (${Object.keys(toolsDelta).join(", ") || "none"}), ${digestMetrics.turns_used} turns, $${(digestMetrics.cost_cents / 100).toFixed(4)}${digestMetrics.large_digest_zero_fetch ? ", large_digest_zero_fetch=true" : ""}`);
      options.onDigestMetrics?.(digestMetrics);
    }

    options.onNarration?.(narration);

    if (narration.content.trim().length === 0) {
      log.error("[feeds] Digest narration is empty — skipping Discord send");
      return;
    }

    try {
      await options.bot.sendToChannel(options.channelId, narration.content);
    } catch (error) {
      log.error("[feeds] Failed to send digest to Discord:", error);
    }

    if (options.qualityPath && options.agent.evaluateDigestQuality && digestMetrics) {
      try {
        const evaluation = await options.agent.evaluateDigestQuality({
          digestText: narration.content,
          items: options.items,
          metrics: {
            items_offered: digestMetrics.items_offered,
            items_fetched: digestMetrics.items_fetched,
            large_digest_zero_fetch: digestMetrics.large_digest_zero_fetch,
            tool_calls: digestMetrics.tool_calls,
            feed_ids: digestMetrics.feed_ids,
            fetched_item_urls: collectFetchedItems(options.items, options.agent.getLastToolCalls?.() ?? [])
              .map((item) => normalizeComparableUrl(item.url))
              .filter((url) => url.length > 0),
          },
          model: digestModel,
          thinkingLevel: digestThinkingLevel,
        });

        if (evaluation) {
          appendJsonLine(options.qualityPath, evaluation);
          log.log(`[feeds] Digest quality: relevance=${evaluation.scores.relevance} depth=${evaluation.scores.depth} originality=${evaluation.scores.originality} connections=${evaluation.scores.connections} tool_efficiency=${evaluation.scores.tool_efficiency}`);
          options.onDigestQuality?.(evaluation);
          if (options.sourceReviewPath) {
            updateFeedSourceReview({
              reviewPath: options.sourceReviewPath,
              items: options.items,
              fetchedItems: collectFetchedItems(options.items, options.agent.getLastToolCalls?.() ?? []),
              evaluation,
              feedMetadata,
            });
          }
        }
      } catch (error) {
        log.error("[feeds] Digest quality evaluation failed:", error);
      }
    } else if (options.sourceReviewPath && digestMetrics) {
      updateFeedSourceReview({
        reviewPath: options.sourceReviewPath,
        items: options.items,
        fetchedItems: collectFetchedItems(options.items, options.agent.getLastToolCalls?.() ?? []),
        evaluation: null,
        feedMetadata,
      });
    }
  }, "feed");
}
