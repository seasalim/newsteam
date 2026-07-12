import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  appendPendingItems,
  buildContextSection,
  buildFeedDigestPrompt,
  buildInterestsSection,
  buildLensSection,
  buildWeeklySynthesisPrompt,
  clearPendingItems,
  type DigestArchiveEntry,
  type FeedContextEntry,
  isDigestTime,
  isSynthesisTime,
  loadDigestArchive,
  loadFeedContext,
  loadFeedRegistryMetadata,
  loadInterests,
  loadLens,
  loadPendingItems,
  normalizeComparableUrl,
  runDigestDelivery,
  runFeedMonitorCycle,
  runWeeklySynthesis,
  saveDigestArchive,
  appendDigestArchive,
  saveFeedContext,
  savePendingItems,
  selectDigestItems,
} from "../src/feeds.ts";
import { JobQueue } from "../src/scheduler.ts";

function createFeedsConfig(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    check_interval_minutes: 15,
    waking_hours_start: 8,
    waking_hours_end: 23,
    channel_id: "feed-channel",
    max_items_per_digest: 5,
    max_queue_age_hours: 8,
    ...overrides,
  };
}

function createLogger() {
  const logs: string[] = [];
  const errors: string[] = [];

  return {
    logs,
    errors,
    log: (...parts: unknown[]) => {
      logs.push(parts.map(String).join(" "));
    },
    error: (...parts: unknown[]) => {
      errors.push(parts.map(String).join(" "));
    },
  };
}

function createAgent() {
  const prompts: string[] = [];

  return {
    prompts,
    clearWindow() {},
    async chat(prompt: string) {
      prompts.push(prompt);
      return {
        content: "narration",
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    },
  };
}

function createAgentWithToolTelemetry(options: {
  toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
  content?: string;
  evaluation?: {
    scores: {
      relevance: number;
      depth: number;
      originality: number;
      connections: number;
      tool_efficiency: number;
    };
    summary: string;
    attempt_count?: number;
    used_repair?: boolean;
    used_strict_retry?: boolean;
    validation_error?: string | null;
    suspicious_reasons?: string[];
    confidence?: "high" | "low";
  };
  onEvaluateDigestQuality?: (input: {
    digestText: string;
    items: Array<{ feed_name?: string; title?: string; url?: string; snippet?: string | null }>;
    metrics: {
      items_offered: number;
      items_fetched: number;
      large_digest_zero_fetch?: boolean;
      tool_calls: number;
      feed_ids: string[];
      fetched_item_urls?: string[];
    };
  }) => void;
} = {}) {
  const prompts: string[] = [];
  let statsReads = 0;
  const toolCalls = options.toolCalls ?? [];
  const toolUsage = toolCalls.reduce<Record<string, number>>((acc, call) => {
    acc[call.name] = (acc[call.name] ?? 0) + 1;
    return acc;
  }, {});

  return {
    prompts,
    clearWindow() {},
    async chat(prompt: string) {
      prompts.push(prompt);
      return {
        content: options.content ?? "narration",
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    },
    getBudgetStats() {
      const before = {
        toolCalls: 0,
        toolUsage: {},
        costCents: 0,
        turns: 0,
      };
      const after = {
        toolCalls: toolCalls.length,
        toolUsage,
        costCents: 1.25,
        turns: 1,
      };

      const stats = statsReads === 0 ? before : after;
      statsReads += 1;
      return stats;
    },
    getLastToolCalls() {
      return toolCalls;
    },
    async evaluateDigestQuality(input: {
      digestText: string;
      items: Array<{ feed_name?: string; title?: string; url?: string; snippet?: string | null }>;
      metrics: {
        items_offered: number;
        items_fetched: number;
        large_digest_zero_fetch?: boolean;
        tool_calls: number;
        feed_ids: string[];
        fetched_item_urls?: string[];
      };
    }) {
      options.onEvaluateDigestQuality?.(input);
      if (!options.evaluation) return null;
      return {
        timestamp: new Date().toISOString(),
        ...options.evaluation,
        input_tokens: 6,
        output_tokens: 3,
        cost_cents: 0.25,
        model: "anthropic/claude-haiku-4-5",
      };
    },
  };
}

function createBot() {
  const sent: Array<{ channelId: string; text: string }> = [];

  return {
    sent,
    async sendToChannel(channelId: string, text: string) {
      sent.push({ channelId, text });
    },
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvedValue) => {
    resolve = resolvedValue;
  });

  return { promise, resolve };
}

async function flushAsyncWork() {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}


test("runFeedMonitorCycle skips checks outside waking hours and runs them inside waking hours", async () => {
  const logger = createLogger();
  const queue = new JobQueue();
  const agent = createAgent();
  const bot = createBot();
  let checkCount = 0;

  const checkFeeds = async () => {
    checkCount += 1;
    return { new_items: [] };
  };

  await runFeedMonitorCycle({
    feedsConfig: createFeedsConfig(),
    jobQueue: queue,
    agent,
    bot,
    log: logger,
    getCurrentPacificHour: () => 3,
    checkFeeds,
  });

  assert.equal(checkCount, 0);

  await runFeedMonitorCycle({
    feedsConfig: createFeedsConfig(),
    jobQueue: queue,
    agent,
    bot,
    log: logger,
    getCurrentPacificHour: () => 9,
    checkFeeds,
  });

  assert.equal(checkCount, 1);
});

test("buildFeedDigestPrompt formats new items for narration", () => {
  const prompt = buildFeedDigestPrompt([
    {
      feed_name: "The Innermost Loop",
      title: "The $0.002 Arbitrage is Here",
      url: "https://example.com/post-1",
      snippet: "First 200 chars of content...",
    },
    {
      feed_name: "Example API",
      title: "Governance Reform",
      url: "https://example.com/post-2",
      snippet: "",
    },
  ]);

  // Verify key structural elements of the new prompt format
  assert.ok(prompt.includes("Here are fresh items from your feeds"), "should contain header");
  assert.ok(prompt.includes("## Your task"), "should contain task section");
  assert.ok(prompt.includes("## How to approach this"), "should contain approach section");
  assert.ok(prompt.includes("web_fetch"), "should mention web_fetch tool");
  assert.ok(prompt.includes("## Style guidelines"), "should contain style section");
  assert.ok(prompt.includes("[The Innermost Loop] The $0.002 Arbitrage is Here"), "should contain first item");
  assert.ok(prompt.includes("https://example.com/post-1"), "should contain first URL");
  assert.ok(prompt.includes("First 200 chars of content..."), "should contain snippet");
  assert.ok(prompt.includes("[Example API] Governance Reform"), "should contain second item");
  assert.ok(prompt.includes("https://example.com/post-2"), "should contain second URL");
  assert.ok(prompt.includes("Snippet unavailable; title only."), "should mark items with no snippet");
  assert.ok(!prompt.includes("Do NOT use any tools"), "should NOT contain old tool ban");
});

test("buildFeedDigestPrompt warns against unsupported causal claims", () => {
  const prompt = buildFeedDigestPrompt([
    {
      feed_name: "Test Feed",
      title: "Hotel closes amid regional slowdown",
      url: "https://example.com/post",
      snippet: "",
    },
  ]);

  assert.ok(prompt.includes("Do NOT turn timing or surrounding context into causation."), "should forbid correlation-to-causation leaps");
  assert.ok(prompt.includes("business, tourism, sports, or culture item"), "should require extra caution for second-order effect examples");
  assert.ok(prompt.includes("Keep source facts siloed."), "should forbid cross-article fact splicing");
  assert.ok(prompt.includes("general analysis or commentary piece"), "should distinguish commentary from event evidence");
});

test("buildFeedDigestPrompt raises fetch expectations for large digests", () => {
  const items = Array.from({ length: 16 }, (_, index) => ({
    feed_id: "thin-feed",
    feed_name: "Thin Feed",
    title: `Post ${index + 1}`,
    url: `https://example.com/${index + 1}`,
    snippet: `Snippet ${index + 1}`,
  }));
  const metadata = new Map([
    ["thin-feed", {
      id: "thin-feed",
      name: "Thin Feed",
      fetchHint: "auto" as const,
      contentQuality: "thin-snippet" as const,
    }],
  ]);

  const prompt = buildFeedDigestPrompt(items, [], "", "", metadata);

  assert.match(prompt, /## Large-digest fetch expectation/u);
  assert.match(prompt, /This digest has 16 items/u);
  assert.match(prompt, /Aim to fetch 2-5 of the most important or ambiguous items/u);
  assert.match(prompt, /Prioritize feeds marked `thin-snippet`/u);
});

test("normalizeComparableUrl strips common RSS tracking params", () => {
  assert.equal(
    normalizeComparableUrl("https://www.bbc.com/news/articles/cp8ddydl18vo?at_medium=RSS&at_campaign=rss"),
    "https://www.bbc.com/news/articles/cp8ddydl18vo",
  );
  assert.equal(
    normalizeComparableUrl("https://www.aljazeera.com/news/2026/4/15/example?traffic_source=rss"),
    "https://www.aljazeera.com/news/2026/4/15/example",
  );
});

test("buildFeedDigestPrompt includes feed-specific fetch hints when registry metadata is provided", () => {
  const metadata = new Map([
    ["hnrss-frontpage", {
      id: "hnrss-frontpage",
      name: "HNRSS Frontpage",
      fetchHint: "always",
      contentQuality: "thin-snippet",
    }],
    ["example-api", {
      id: "example-api",
      name: "Example API",
      fetchHint: "never",
      contentQuality: "full-text",
    }],
  ]);

  const prompt = buildFeedDigestPrompt([
    {
      feed_id: "hnrss-frontpage",
      feed_name: "HNRSS Frontpage",
      title: "Thin item",
      url: "https://example.com/hn",
      snippet: "Thin snippet",
    },
    {
      feed_id: "example-api",
      feed_name: "Example API",
      title: "Full item",
      url: "https://example.com/molt",
      snippet: "Full content",
    },
  ], [], "", "", metadata);

  assert.ok(prompt.includes("## Feed-specific fetch hints"), "should contain fetch hints section");
  assert.ok(prompt.includes("HNRSS Frontpage (`hnrss-frontpage`): fetch before making strong claims"), "should include always-fetch guidance");
  assert.ok(prompt.includes("Example API (`example-api`): usually skip fetching"), "should include never-fetch guidance");
  assert.ok(prompt.includes("Fetch hint: always; content quality: thin-snippet."), "should annotate thin snippet feed items");
  assert.ok(prompt.includes("Fetch hint: never; content quality: full-text."), "should annotate full-text feed items");
});

test("buildFeedDigestPrompt includes context section when context is provided", () => {
  const context: FeedContextEntry[] = [
    {
      timestamp: "2026-03-27T09:00:00Z",
      topics: ["AI agents", "crypto regulation"],
      entities: ["OpenAI", "SEC"],
      sentiment: "cautious",
      summary: "AI agent tooling evolving fast; SEC signaling new crypto rules.",
    },
  ];

  const prompt = buildFeedDigestPrompt(
    [{ feed_name: "Test", title: "Test Article", url: "https://example.com", snippet: "Content" }],
    context,
  );

  assert.ok(prompt.includes("## Recent digest context"), "should contain context section");
  assert.ok(prompt.includes("AI agents"), "should contain topics from context");
  assert.ok(prompt.includes("OpenAI"), "should contain entities from context");
  assert.ok(prompt.includes("cautious"), "should contain sentiment from context");
});

test("buildFeedDigestPrompt omits context section when context is empty", () => {
  const prompt = buildFeedDigestPrompt(
    [{ feed_name: "Test", title: "Test Article", url: "https://example.com", snippet: "Content" }],
    [],
  );

  assert.ok(!prompt.includes("## Recent digest context"), "should not contain context section");
});

test("loadFeedContext returns empty array for missing file", () => {
  const entries = loadFeedContext("/tmp/nonexistent-feed-context-file.json");
  assert.deepEqual(entries, []);
});

test("saveFeedContext and loadFeedContext round-trip correctly", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "feed-context-"));
  const ctxPath = path.join(dir, "feed_context.json");

  const entries: FeedContextEntry[] = [
    {
      timestamp: "2026-03-27T09:00:00Z",
      topics: ["topic1"],
      entities: ["entity1"],
      sentiment: "bullish",
      summary: "Test summary",
    },
  ];

  saveFeedContext(ctxPath, entries);
  const loaded = loadFeedContext(ctxPath);
  assert.deepEqual(loaded, entries);
});

test("saveFeedContext trims to max entries", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "feed-context-trim-"));
  const ctxPath = path.join(dir, "feed_context.json");

  // Create 12 entries (max is 8)
  const entries: FeedContextEntry[] = Array.from({ length: 12 }, (_, i) => ({
    timestamp: `2026-03-${String(i + 1).padStart(2, "0")}T09:00:00Z`,
    topics: [`topic-${i}`],
    entities: [],
    sentiment: "neutral",
    summary: `Summary ${i}`,
  }));

  saveFeedContext(ctxPath, entries);
  const loaded = loadFeedContext(ctxPath);
  assert.equal(loaded.length, 8, "should trim to 8 entries");
  assert.equal(loaded[0].summary, "Summary 4", "should keep the most recent entries");
});

test("buildContextSection formats entries correctly", () => {
  const entries: FeedContextEntry[] = [
    {
      timestamp: "2026-03-27T09:00:00Z",
      topics: ["AI", "crypto"],
      entities: ["OpenAI"],
      sentiment: "bullish",
      summary: "AI and crypto are converging.",
    },
  ];

  const section = buildContextSection(entries);
  assert.ok(section.includes("2026-03-27"), "should contain date");
  assert.ok(section.includes("AI, crypto"), "should contain topics");
  assert.ok(section.includes("OpenAI"), "should contain entities");
  assert.ok(section.includes("bullish"), "should contain sentiment");
  assert.ok(section.includes("AI and crypto are converging"), "should contain summary");
});

test("buildContextSection returns empty string for empty entries", () => {
  assert.equal(buildContextSection([]), "");
});

// ── Interests tests ──────────────────────────────────────────────

test("loadInterests returns empty string for missing file", () => {
  assert.equal(loadInterests("/tmp/nonexistent-interests.md"), "");
});

test("loadInterests reads file contents", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "interests-"));
  const filePath = path.join(dir, "INTERESTS.md");
  writeFileSync(filePath, "## Core\n- AI agents\n- Crypto");

  const result = loadInterests(filePath);
  assert.ok(result.includes("AI agents"));
  assert.ok(result.includes("Crypto"));
});

test("buildInterestsSection returns empty string for empty interests", () => {
  assert.equal(buildInterestsSection(""), "");
});

test("buildInterestsSection formats interests with header", () => {
  const section = buildInterestsSection("## Core\n- AI agents ★★★\n- Crypto ★★★");
  assert.ok(section.includes("## Your interests & domain priorities"), "should have header");
  assert.ok(section.includes("AI agents"), "should include interest content");
  assert.ok(section.includes("high-weight interests deserve deeper analysis"), "should include guidance");
});

test("buildFeedDigestPrompt includes interests section when provided", () => {
  const items = [{ feed_name: "Test", title: "Article", url: "https://example.com", snippet: "Content" }];
  const interests = "## Core\n- AI agents ★★★";

  const prompt = buildFeedDigestPrompt(items, [], interests);
  assert.ok(prompt.includes("## Your interests & domain priorities"), "should contain interests section");
  assert.ok(prompt.includes("AI agents"), "should contain interest content");
  assert.ok(prompt.includes("Score each against your interests"), "should reference interests in triage step");
});

test("buildFeedDigestPrompt omits interests section when not provided", () => {
  const items = [{ feed_name: "Test", title: "Article", url: "https://example.com", snippet: "Content" }];

  const prompt = buildFeedDigestPrompt(items);
  assert.ok(!prompt.includes("## Your interests & domain priorities"), "should not contain interests section");
});

// ── Lens tests ───────────────────────────────────────────────────

test("loadLens returns empty string for missing file", () => {
  assert.equal(loadLens("/tmp/nonexistent-lens.md"), "");
});

test("buildLensSection returns empty string for empty lens", () => {
  assert.equal(buildLensSection(""), "");
});

test("buildLensSection formats lens with header", () => {
  const section = buildLensSection("Analyze through the lens of power dynamics.");
  assert.ok(section.includes("## Your analytical lens"), "should have header");
  assert.ok(section.includes("power dynamics"), "should include lens content");
});

test("buildFeedDigestPrompt includes lens and replaces default style when provided", () => {
  const items = [{ feed_name: "Test", title: "Article", url: "https://example.com", snippet: "Content" }];
  const lens = "Analyze through power dynamics. Structure as SITREP.";

  const prompt = buildFeedDigestPrompt(items, [], "", lens);
  assert.ok(prompt.includes("## Your analytical lens"), "should contain lens section");
  assert.ok(prompt.includes("power dynamics"), "should contain lens content");
  assert.ok(!prompt.includes("## Style guidelines"), "should NOT contain default style guidelines when lens is present");
  assert.ok(prompt.includes("## CRITICAL: Links"), "links requirement must survive a custom lens");
});

test("buildFeedDigestPrompt uses default style when no lens provided", () => {
  const items = [{ feed_name: "Test", title: "Article", url: "https://example.com", snippet: "Content" }];

  const prompt = buildFeedDigestPrompt(items);
  assert.ok(prompt.includes("## Style guidelines"), "should contain default style guidelines");
  assert.ok(!prompt.includes("## Your analytical lens"), "should NOT contain lens section");
  assert.ok(prompt.includes("## CRITICAL: Links"), "links requirement present without a lens");
});

test("buildFeedDigestPrompt references analytical lens in approach step", () => {
  const items = [{ feed_name: "Test", title: "Article", url: "https://example.com", snippet: "Content" }];
  const lens = "Analyze through power dynamics.";

  const prompt = buildFeedDigestPrompt(items, [], "", lens);
  assert.ok(prompt.includes("through your analytical lens"), "should reference lens in approach step");
});

test("runFeedMonitorCycle drops a feed job while a user job is running", async () => {
  const logger = createLogger();
  const queue = new JobQueue();
  const blocker = createDeferred<void>();
  const agent = createAgent();
  const bot = createBot();

  const userJob = queue.enqueue(async () => {
    await blocker.promise;
  }, "user");

  await flushAsyncWork();

  await runFeedMonitorCycle({
    feedsConfig: createFeedsConfig(),
    jobQueue: queue,
    agent,
    bot,
    log: logger,
    getCurrentPacificHour: () => 10,
    checkFeeds: async () => ({
      new_items: [
        {
          feed_name: "The Innermost Loop",
          title: "Fresh Post",
          url: "https://example.com/post",
          snippet: "Snippet",
        },
      ],
    }),
  });

  assert.deepEqual(agent.prompts, []);
  assert.deepEqual(bot.sent, []);
  assert.equal(
    logger.logs.includes("[feeds] Skipping digest while another job is running"),
    true,
  );

  blocker.resolve();
  await userJob;
});

function createTempPendingPath(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "newsteam-feeds-test-"));
  return path.join(dir, "feeds_pending.json");
}

test("appendPendingItems accumulates items with deduplication", () => {
  const pendingPath = createTempPendingPath();

  const firstBatch = [
    { feed_name: "Feed A", title: "Post 1", url: "https://example.com/1" },
    { feed_name: "Feed A", title: "Post 2", url: "https://example.com/2" },
  ];

  appendPendingItems(firstBatch, pendingPath);
  assert.equal(loadPendingItems(pendingPath).length, 2);

  const secondBatch = [
    { feed_name: "Feed A", title: "Post 2", url: "https://example.com/2" }, // duplicate
    { feed_name: "Feed B", title: "Post 3", url: "https://example.com/3" }, // new
  ];

  appendPendingItems(secondBatch, pendingPath);
  const items = loadPendingItems(pendingPath);
  assert.equal(items.length, 3);
  assert.deepEqual(
    items.map((i) => i.url),
    ["https://example.com/1", "https://example.com/2", "https://example.com/3"],
  );
});

test("appendPendingItems treats same-title different-URL items as distinct", () => {
  const pendingPath = createTempPendingPath();

  const firstBatch = [
    { feed_name: "Feed A", title: "Breaking News", url: "https://example.com/1" },
  ];

  appendPendingItems(firstBatch, pendingPath);

  // Same title, different URL — should NOT be deduped
  const secondBatch = [
    { feed_name: "Feed B", title: "Breaking News", url: "https://other.com/1" },
  ];

  appendPendingItems(secondBatch, pendingPath);
  const items = loadPendingItems(pendingPath);
  assert.equal(items.length, 2);
  assert.deepEqual(
    items.map((i) => i.url),
    ["https://example.com/1", "https://other.com/1"],
  );
});

test("appendPendingItems skips items with no URL and no title", () => {
  const pendingPath = createTempPendingPath();

  appendPendingItems([
    { feed_name: "Feed A", title: "Real Post", url: "https://example.com/1" },
    { feed_name: "Feed A" }, // no url, no title — should be skipped
  ], pendingPath);

  const items = loadPendingItems(pendingPath);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "Real Post");
});

test("loadFeedRegistryMetadata reads fetch hints from feeds.json", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "feed-registry-"));
  const feedsPath = path.join(dir, "feeds.json");

  writeFileSync(feedsPath, JSON.stringify([
    {
      id: "thin-feed",
      name: "Thin Feed",
      fetch_hint: "always",
      content_quality: "thin-snippet",
    },
    {
      id: "full-feed",
      name: "Full Feed",
      fetch_hint: "never",
      content_quality: "full-text",
    },
  ], null, 2));

  const metadata = loadFeedRegistryMetadata(feedsPath);
  assert.equal(metadata.get("thin-feed")?.fetchHint, "always");
  assert.equal(metadata.get("thin-feed")?.contentQuality, "thin-snippet");
  assert.equal(metadata.get("full-feed")?.fetchHint, "never");
  assert.equal(metadata.get("full-feed")?.contentQuality, "full-text");
});

test("loadFeedRegistryMetadata reads retention overrides from feeds.json", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "feed-registry-retention-"));
  const feedsPath = path.join(dir, "feeds.json");

  writeFileSync(feedsPath, JSON.stringify([
    {
      id: "slow-feed",
      name: "Slow Feed",
      max_queue_age_hours: 72,
    },
    {
      id: "news-feed",
      name: "News Feed",
      max_queue_age_hours: 12,
      max_content_age_hours: 24,
    },
  ], null, 2));

  const metadata = loadFeedRegistryMetadata(feedsPath);
  assert.equal(metadata.get("slow-feed")?.maxQueueAgeHours, 72);
  assert.equal(metadata.get("slow-feed")?.maxContentAgeHours, undefined);
  assert.equal(metadata.get("news-feed")?.maxQueueAgeHours, 12);
  assert.equal(metadata.get("news-feed")?.maxContentAgeHours, 24);
});

test("loadPendingItems returns empty array when file missing", () => {
  const pendingPath = path.join(tmpdir(), "nonexistent-dir-" + Date.now(), "feeds_pending.json");
  const items = loadPendingItems(pendingPath);
  assert.deepEqual(items, []);
});

test("loadPendingItems returns empty array when file contains a non-array payload", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pending-invalid-shape-"));
  const pendingPath = path.join(dir, "feeds_pending.json");
  writeFileSync(pendingPath, JSON.stringify({ unexpected: true }), "utf-8");

  const items = loadPendingItems(pendingPath);
  assert.deepEqual(items, []);
});

test("loadPendingItems prunes stale items by queue age using published as a legacy fallback", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pending-max-age-"));
  const pendingPath = path.join(dir, "feeds_pending.json");
  const now = Date.now();

  writeFileSync(pendingPath, JSON.stringify([
    {
      title: "Fresh enough",
      url: "https://example.com/fresh",
      published: new Date(now - (10 * 60 * 60 * 1000)).toISOString(),
    },
    {
      title: "Too old",
      url: "https://example.com/stale",
      published: new Date(now - (13 * 60 * 60 * 1000)).toISOString(),
    },
  ]), "utf-8");

  const items = loadPendingItems(pendingPath, { maxQueueAgeHours: 12 });
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "Fresh enough");
});

test("loadPendingItems uses queued_at for queue-age pruning", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pending-queued-at-"));
  const pendingPath = path.join(dir, "feeds_pending.json");
  const now = Date.now();

  writeFileSync(pendingPath, JSON.stringify([
    {
      title: "Rare but newly queued",
      url: "https://example.com/rare",
      published: new Date(now - (7 * 24 * 60 * 60 * 1000)).toISOString(),
      queued_at: new Date(now - (2 * 60 * 60 * 1000)).toISOString(),
    },
    {
      title: "Queued too long",
      url: "https://example.com/late",
      published: new Date(now - (2 * 60 * 60 * 1000)).toISOString(),
      queued_at: new Date(now - (14 * 60 * 60 * 1000)).toISOString(),
    },
  ]), "utf-8");

  const items = loadPendingItems(pendingPath, { maxQueueAgeHours: 12 });
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "Rare but newly queued");
});

test("loadPendingItems prunes by content age when configured", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pending-content-age-"));
  const pendingPath = path.join(dir, "feeds_pending.json");
  const now = Date.now();

  writeFileSync(pendingPath, JSON.stringify([
    {
      title: "Still fresh enough",
      url: "https://example.com/fresh-content",
      published: new Date(now - (10 * 60 * 60 * 1000)).toISOString(),
      queued_at: new Date(now - (2 * 60 * 60 * 1000)).toISOString(),
    },
    {
      title: "Content too old",
      url: "https://example.com/stale-content",
      published: new Date(now - (30 * 60 * 60 * 1000)).toISOString(),
      queued_at: new Date(now - (1 * 60 * 60 * 1000)).toISOString(),
    },
  ]), "utf-8");

  const items = loadPendingItems(pendingPath, {
    maxQueueAgeHours: 12,
    maxContentAgeHours: 24,
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "Still fresh enough");
});

test("loadPendingItems applies per-feed retention overrides before agent defaults", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pending-feed-override-"));
  const pendingPath = path.join(dir, "feeds_pending.json");
  const feedsPath = path.join(dir, "feeds.json");
  const now = Date.now();

  writeFileSync(feedsPath, JSON.stringify([
    { id: "slow-feed", name: "Slow Feed", max_queue_age_hours: 72 },
    { id: "news-feed", name: "News Feed", max_queue_age_hours: 12, max_content_age_hours: 24 },
  ]), "utf-8");

  writeFileSync(pendingPath, JSON.stringify([
    {
      feed_id: "slow-feed",
      title: "Slow post",
      url: "https://example.com/slow",
      published: new Date(now - (48 * 60 * 60 * 1000)).toISOString(),
      queued_at: new Date(now - (6 * 60 * 60 * 1000)).toISOString(),
    },
    {
      feed_id: "news-feed",
      title: "Old headline",
      url: "https://example.com/news",
      published: new Date(now - (30 * 60 * 60 * 1000)).toISOString(),
      queued_at: new Date(now - (1 * 60 * 60 * 1000)).toISOString(),
    },
  ]), "utf-8");

  const items = loadPendingItems(pendingPath, {
    feedsPath,
    maxQueueAgeHours: 12,
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].feed_id, "slow-feed");
});

test("appendPendingItems stamps queued_at and preserves it for deduped items", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pending-queue-stamp-"));
  const pendingPath = path.join(dir, "feeds_pending.json");
  const feedsPath = path.join(dir, "feeds.json");
  const firstNow = Date.UTC(2026, 3, 10, 12, 0, 0);
  const secondNow = Date.UTC(2026, 3, 10, 13, 0, 0);

  writeFileSync(feedsPath, JSON.stringify([
    { id: "feed-a", name: "Feed A" },
  ]), "utf-8");

  const firstBatch = [
    { feed_id: "feed-a", feed_name: "Feed A", title: "Post 1", url: "https://example.com/1" },
  ];
  appendPendingItems(firstBatch, pendingPath, { feedsPath, nowMs: firstNow });

  const firstItems = loadPendingItems(pendingPath, { nowMs: firstNow });
  assert.equal(firstItems.length, 1);
  assert.equal(firstItems[0].queued_at, new Date(firstNow).toISOString());

  const secondBatch = [
    { feed_id: "feed-a", feed_name: "Feed A", title: "Post 1", url: "https://example.com/1" },
    { feed_id: "feed-a", feed_name: "Feed A", title: "Post 2", url: "https://example.com/2" },
  ];
  appendPendingItems(secondBatch, pendingPath, { feedsPath, nowMs: secondNow });

  const items = loadPendingItems(pendingPath, { nowMs: secondNow });
  assert.equal(items.length, 2);
  assert.equal(items[0].queued_at, new Date(firstNow).toISOString());
  assert.equal(items[1].queued_at, new Date(secondNow).toISOString());
});

test("selectDigestItems round-robins across feeds for balanced selection", () => {
  const items = [
    { feed_id: "hn", feed_name: "HN", title: "HN-1" },
    { feed_id: "hn", feed_name: "HN", title: "HN-2" },
    { feed_id: "hn", feed_name: "HN", title: "HN-3" },
    { feed_id: "hn", feed_name: "HN", title: "HN-4" },
    { feed_id: "hn", feed_name: "HN", title: "HN-5" },
    { feed_id: "api", feed_name: "Example API", title: "API-1" },
    { feed_id: "api", feed_name: "Example API", title: "API-2" },
    { feed_id: "rss", feed_name: "Example RSS", title: "RSS-1" },
    { feed_id: "rss", feed_name: "Example RSS", title: "RSS-2" },
    { feed_id: "rss", feed_name: "Example RSS", title: "RSS-3" },
  ];

  const { selected, remaining } = selectDigestItems(items, 6);

  // Should pick from each feed before going back for seconds
  const feedOrder = selected.map((i) => i.feed_id);
  assert.equal(selected.length, 6);
  // First round: one from each feed (hn, api, rss)
  assert.deepEqual(feedOrder.slice(0, 3), ["hn", "api", "rss"]);
  // Second round: one more from each feed (hn, api, rss)
  assert.deepEqual(feedOrder.slice(3, 6), ["hn", "api", "rss"]);

  // Remaining should be the leftover items
  assert.equal(remaining.length, 4);
});

test("selectDigestItems returns all items when under the cap", () => {
  const items = [
    { feed_id: "hn", title: "HN-1" },
    { feed_id: "mb", title: "MB-1" },
  ];
  const { selected, remaining } = selectDigestItems(items, 10);
  assert.equal(selected.length, 2);
  assert.equal(remaining.length, 0);
});

test("selectDigestItems handles single-feed gracefully", () => {
  const items = Array.from({ length: 10 }, (_, i) => ({
    feed_id: "hn",
    title: `HN-${i + 1}`,
  }));
  const { selected, remaining } = selectDigestItems(items, 3);
  assert.equal(selected.length, 3);
  assert.equal(remaining.length, 7);
  assert.deepEqual(selected.map((i) => i.title), ["HN-1", "HN-2", "HN-3"]);
});

test("runFeedMonitorCycle accumulates items when digest_times is configured", async () => {
  const logger = createLogger();
  const queue = new JobQueue();
  const agent = createAgent();
  const bot = createBot();
  const pendingPath = createTempPendingPath();

  const feedItems = [
    { feed_name: "Feed A", title: "Post 1", url: "https://example.com/1", snippet: "Snippet 1" },
    { feed_name: "Feed B", title: "Post 2", url: "https://example.com/2", snippet: "Snippet 2" },
  ];

  await runFeedMonitorCycle({
    feedsConfig: createFeedsConfig({ digest_times: ["09:00", "18:00"] }),
    jobQueue: queue,
    agent,
    bot,
    log: logger,
    getCurrentPacificHour: () => 10,
    checkFeeds: async () => ({ new_items: feedItems }),
    pendingPath,
  });

  // Items should be accumulated, not narrated
  assert.deepEqual(agent.prompts, []);
  assert.deepEqual(bot.sent, []);

  // Items should be in the pending file
  const pending = loadPendingItems(pendingPath);
  assert.equal(pending.length, 2);

  // Log should mention accumulation
  assert.ok(logger.logs.some((l) => l.includes("Accumulated 2 items")));
});

test("runFeedMonitorCycle in batched mode accumulates ALL items beyond max_items_per_digest", async () => {
  const logger = createLogger();
  const queue = new JobQueue();
  const agent = createAgent();
  const bot = createBot();
  const pendingPath = createTempPendingPath();

  // 8 items across multiple feeds — more than max_items_per_digest (5)
  const feedItems = Array.from({ length: 8 }, (_, i) => ({
    feed_name: `Feed ${String.fromCharCode(65 + (i % 4))}`,
    title: `Post ${i + 1}`,
    url: `https://example.com/${i + 1}`,
    snippet: `Snippet ${i + 1}`,
  }));

  await runFeedMonitorCycle({
    feedsConfig: createFeedsConfig({ digest_times: ["09:00"], max_items_per_digest: 5 }),
    jobQueue: queue,
    agent,
    bot,
    log: logger,
    getCurrentPacificHour: () => 10,
    checkFeeds: async () => ({ new_items: feedItems }),
    pendingPath,
  });

  // ALL 8 items should be accumulated, not just the first 5
  const pending = loadPendingItems(pendingPath);
  assert.equal(pending.length, 8, "batched mode should accumulate all items, not cap at max_items_per_digest");
  assert.ok(logger.logs.some((l) => l.includes("Accumulated 8 items")));

  // Nothing narrated yet — that happens at digest delivery time
  assert.deepEqual(agent.prompts, []);
  assert.deepEqual(bot.sent, []);
});

test("runFeedMonitorCycle narrates immediately when digest_times is not configured", async () => {
  const logger = createLogger();
  const queue = new JobQueue();
  const agent = createAgent();
  const bot = createBot();

  const feedItems = [
    { feed_name: "Feed A", title: "Post 1", url: "https://example.com/1", snippet: "Snippet 1" },
  ];

  await runFeedMonitorCycle({
    feedsConfig: createFeedsConfig(),
    jobQueue: queue,
    agent,
    bot,
    log: logger,
    getCurrentPacificHour: () => 10,
    checkFeeds: async () => ({ new_items: feedItems }),
  });

  // Should have narrated immediately (legacy mode)
  assert.equal(agent.prompts.length, 1);
  assert.equal(bot.sent.length, 1);
  assert.equal(bot.sent[0].channelId, "feed-channel");
});

test("runFeedMonitorCycle in legacy mode caps items at max_items_per_digest", async () => {
  const logger = createLogger();
  const queue = new JobQueue();
  const agent = createAgent();
  const bot = createBot();

  // 8 items, but max_items_per_digest is 3
  const feedItems = Array.from({ length: 8 }, (_, i) => ({
    feed_name: `Feed ${String.fromCharCode(65 + (i % 4))}`,
    title: `Post ${i + 1}`,
    url: `https://example.com/${i + 1}`,
    snippet: `Snippet ${i + 1}`,
  }));

  await runFeedMonitorCycle({
    feedsConfig: createFeedsConfig({ max_items_per_digest: 3 }),
    jobQueue: queue,
    agent,
    bot,
    log: logger,
    getCurrentPacificHour: () => 10,
    checkFeeds: async () => ({ new_items: feedItems }),
  });

  // Should narrate immediately with only 3 items (capped)
  assert.equal(agent.prompts.length, 1);
  // The prompt should contain exactly 3 items (3 "---" section pairs)
  const sectionCount = (agent.prompts[0].match(/---/g) || []).length;
  assert.equal(sectionCount, 6, "should have 3 items (each has opening and closing ---)");
});

test("runDigestDelivery narrates pending items and clears the file", async () => {
  const logger = createLogger();
  const queue = new JobQueue();
  const agent = createAgent();
  const bot = createBot();
  const pendingPath = createTempPendingPath();

  const items = [
    { feed_name: "Feed A", title: "Post 1", url: "https://example.com/1" },
    { feed_name: "Feed B", title: "Post 2", url: "https://example.com/2" },
  ];
  savePendingItems(items, pendingPath);

  await runDigestDelivery({
    feedsConfig: createFeedsConfig(),
    jobQueue: queue,
    agent,
    bot,
    log: logger,
    pendingPath,
  });

  // Should have narrated
  assert.equal(agent.prompts.length, 1);
  assert.equal(bot.sent.length, 1);

  // Pending file should be cleared
  const remaining = loadPendingItems(pendingPath);
  assert.equal(remaining.length, 0);
});

test("runDigestDelivery keeps overflow items when batch exceeds max_items_per_digest", async () => {
  const logger = createLogger();
  const queue = new JobQueue();
  const agent = createAgent();
  const bot = createBot();
  const pendingPath = createTempPendingPath();

  const items = Array.from({ length: 10 }, (_, i) => ({
    feed_name: "Feed",
    title: `Post ${i + 1}`,
    url: `https://example.com/${i + 1}`,
  }));
  savePendingItems(items, pendingPath);

  await runDigestDelivery({
    feedsConfig: createFeedsConfig({ max_items_per_digest: 5 }),
    jobQueue: queue,
    agent,
    bot,
    log: logger,
    pendingPath,
  });

  // Should have narrated
  assert.equal(agent.prompts.length, 1);

  // 5 items should remain (the overflow)
  const remaining = loadPendingItems(pendingPath);
  assert.equal(remaining.length, 5);
  assert.equal(remaining[0].title, "Post 6");
});

test("runDigestDelivery emits fetch metrics mapped back to feed ids", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "feed-metrics-"));
  const pendingPath = path.join(dir, "feeds_pending.json");
  const feedsPath = path.join(dir, "feeds.json");
  const logger = createLogger();
  const queue = new JobQueue();
  const agent = createAgentWithToolTelemetry({
    toolCalls: [
      { name: "web_fetch", args: { url: "https://example.com/1" } },
      { name: "web_fetch", args: { url: "https://example.com/2/" } },
    ],
  });
  const bot = createBot();

  writeFileSync(feedsPath, JSON.stringify([
    {
      id: "thin-feed",
      name: "Thin Feed",
      fetch_hint: "always",
      content_quality: "thin-snippet",
    },
    {
      id: "full-feed",
      name: "Full Feed",
      fetch_hint: "never",
      content_quality: "full-text",
    },
  ], null, 2));

  savePendingItems([
    {
      feed_id: "thin-feed",
      feed_name: "Thin Feed",
      title: "Post 1",
      url: "https://example.com/1",
      snippet: "Thin snippet",
    },
    {
      feed_id: "full-feed",
      feed_name: "Full Feed",
      title: "Post 2",
      url: "https://example.com/2",
      snippet: "Full text snippet",
    },
  ], pendingPath);

  let metrics:
    | undefined
    | {
      items_fetched: number;
      fetched_feed_ids: string[];
      fetch_hint_counts: Record<string, number>;
    };

  await runDigestDelivery({
    feedsConfig: createFeedsConfig(),
    jobQueue: queue,
    agent,
    bot,
    log: logger,
    pendingPath,
    feedsPath,
    onDigestMetrics: (digestMetrics) => {
      metrics = digestMetrics;
    },
  });

  assert.ok(metrics, "should emit digest metrics");
  assert.equal(metrics?.items_fetched, 2);
  assert.deepEqual(metrics?.fetched_feed_ids, ["thin-feed", "full-feed"]);
  assert.deepEqual(metrics?.fetch_hint_counts, { auto: 0, always: 1, never: 1 });
  assert.ok(logger.logs.some((line) => line.includes("2 fetched")), "should log fetched item count");
});

test("runDigestDelivery flags large digests with zero fetches in metrics", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "feed-metrics-large-zero-fetch-"));
  const pendingPath = path.join(dir, "feeds_pending.json");
  const logger = createLogger();
  const queue = new JobQueue();
  const agent = createAgentWithToolTelemetry();
  const bot = createBot();

  savePendingItems(Array.from({ length: 16 }, (_, index) => ({
    feed_id: "thin-feed",
    feed_name: "Thin Feed",
    title: `Post ${index + 1}`,
    url: `https://example.com/${index + 1}`,
    snippet: `Snippet ${index + 1}`,
  })), pendingPath);

  let metrics:
    | undefined
    | {
      items_offered: number;
      items_fetched: number;
      large_digest_zero_fetch: boolean;
    };

  await runDigestDelivery({
    feedsConfig: createFeedsConfig({ max_items_per_digest: 20 }),
    jobQueue: queue,
    agent,
    bot,
    log: logger,
    pendingPath,
    onDigestMetrics: (digestMetrics) => {
      metrics = digestMetrics;
    },
  });

  assert.ok(metrics);
  assert.equal(metrics?.items_offered, 16);
  assert.equal(metrics?.items_fetched, 0);
  assert.equal(metrics?.large_digest_zero_fetch, true);
  assert.ok(
    logger.logs.some((line) => line.includes("large_digest_zero_fetch=true")),
    "should log the large zero-fetch flag",
  );
});

test("runDigestDelivery persists digest quality evaluation without blocking delivery", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "digest-quality-"));
  const pendingPath = path.join(dir, "feeds_pending.json");
  const qualityPath = path.join(dir, "digest_quality.jsonl");
  const logger = createLogger();
  const queue = new JobQueue();
  const agent = createAgentWithToolTelemetry({
    evaluation: {
      scores: {
        relevance: 4,
        depth: 3,
        originality: 3,
        connections: 2,
        tool_efficiency: 5,
      },
      summary: "Good selection, but connections could be stronger.",
    },
  });
  const bot = createBot();

  savePendingItems([
    {
      feed_id: "thin-feed",
      feed_name: "Thin Feed",
      title: "Post 1",
      url: "https://example.com/1",
      snippet: "Snippet",
    },
  ], pendingPath);

  let evaluationSummary = "";
  await runDigestDelivery({
    feedsConfig: createFeedsConfig(),
    jobQueue: queue,
    agent,
    bot,
    log: logger,
    pendingPath,
    qualityPath,
    onDigestQuality: (evaluation) => {
      evaluationSummary = evaluation.summary;
    },
  });

  assert.equal(bot.sent.length, 1, "digest should still be delivered");
  assert.equal(evaluationSummary, "Good selection, but connections could be stronger.");

  const qualityLines = readFileSync(qualityPath, "utf-8").trim().split("\n");
  assert.equal(qualityLines.length, 1);
  const qualityRecord = JSON.parse(qualityLines[0]) as {
    summary: string;
    scores: { relevance: number; tool_efficiency: number };
  };
  assert.equal(qualityRecord.summary, "Good selection, but connections could be stronger.");
  assert.equal(qualityRecord.scores.relevance, 4);
  assert.equal(qualityRecord.scores.tool_efficiency, 5);
  assert.ok(logger.logs.some((line) => line.includes("Digest quality: relevance=4")), "should log digest quality summary");
});

test("runDigestDelivery passes normalized fetched_item_urls to digest quality evaluation", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "digest-quality-fetched-urls-"));
  const pendingPath = path.join(dir, "feeds_pending.json");
  const qualityPath = path.join(dir, "digest_quality.jsonl");
  const logger = createLogger();
  const queue = new JobQueue();
  let capturedMetrics:
    | undefined
    | {
      fetched_item_urls?: string[];
      items_fetched: number;
    };
  const agent = createAgentWithToolTelemetry({
    toolCalls: [
      { name: "web_fetch", args: { url: "https://www.bbc.com/news/articles/cp8ddydl18vo" } },
      { name: "web_fetch", args: { url: "https://example.com/unmatched" } },
    ],
    evaluation: {
      scores: {
        relevance: 4,
        depth: 3,
        originality: 3,
        connections: 2,
        tool_efficiency: 5,
      },
      summary: "Normalized fetched URLs captured.",
    },
    onEvaluateDigestQuality: (input) => {
      capturedMetrics = {
        fetched_item_urls: input.metrics.fetched_item_urls,
        items_fetched: input.metrics.items_fetched,
      };
    },
  });
  const bot = createBot();

  savePendingItems([
    {
      feed_id: "bbc-middle-east",
      feed_name: "BBC Middle East",
      title: "Post 1",
      url: "https://www.bbc.com/news/articles/cp8ddydl18vo?at_medium=RSS&at_campaign=rss",
      snippet: "Snippet",
    },
  ], pendingPath);

  await runDigestDelivery({
    feedsConfig: createFeedsConfig(),
    jobQueue: queue,
    agent,
    bot,
    log: logger,
    pendingPath,
    qualityPath,
  });

  assert.ok(capturedMetrics, "should pass metrics to evaluation");
  assert.equal(capturedMetrics?.items_fetched, 1);
  assert.deepEqual(capturedMetrics?.fetched_item_urls, [
    "https://www.bbc.com/news/articles/cp8ddydl18vo",
  ]);
});

test("runDigestDelivery updates feed source review artifact in recommendation mode", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "feed-review-"));
  const pendingPath = path.join(dir, "feeds_pending.json");
  const qualityPath = path.join(dir, "digest_quality.jsonl");
  const sourceReviewPath = path.join(dir, "feed_source_review.json");
  const feedsPath = path.join(dir, "feeds.json");
  const logger = createLogger();
  const queue = new JobQueue();
  const agent = createAgentWithToolTelemetry({
    toolCalls: [{ name: "web_fetch", args: { url: "https://example.com/1" } }],
    evaluation: {
      scores: {
        relevance: 4,
        depth: 4,
        originality: 3,
        connections: 3,
        tool_efficiency: 5,
      },
      summary: "Strong signal with efficient fetching.",
    },
  });
  const bot = createBot();

  writeFileSync(feedsPath, JSON.stringify([
    {
      id: "thin-feed",
      name: "Thin Feed",
      fetch_hint: "auto",
      content_quality: "thin-snippet",
    },
    {
      id: "full-feed",
      name: "Full Feed",
      fetch_hint: "never",
      content_quality: "full-text",
    },
  ], null, 2));

  savePendingItems([
    {
      feed_id: "thin-feed",
      feed_name: "Thin Feed",
      title: "Post 1",
      url: "https://example.com/1",
      snippet: "Thin snippet",
    },
    {
      feed_id: "full-feed",
      feed_name: "Full Feed",
      title: "Post 2",
      url: "https://example.com/2",
      snippet: "Full-text snippet",
    },
  ], pendingPath);

  await runDigestDelivery({
    feedsConfig: createFeedsConfig(),
    jobQueue: queue,
    agent,
    bot,
    log: logger,
    pendingPath,
    feedsPath,
    qualityPath,
    sourceReviewPath,
  });

  const review = JSON.parse(readFileSync(sourceReviewPath, "utf-8")) as {
    generated_at: string;
    feeds: Array<{
      feed_id: string;
      items_offered: number;
      items_fetched: number;
      quality_samples: number;
      average_overall_score: number | null;
      recommendation: string;
      fetch_recommendation: string;
    }>;
  };

  assert.ok(review.generated_at, "should write generated timestamp");
  assert.equal(review.feeds.length, 2);

  const thinFeed = review.feeds.find((entry) => entry.feed_id === "thin-feed");
  assert.ok(thinFeed, "should include thin feed");
  assert.equal(thinFeed?.items_offered, 1);
  assert.equal(thinFeed?.items_fetched, 1);
  // Proportional attribution: 1 item out of 2 total = 0.5 weight
  assert.equal(thinFeed?.quality_samples, 0.5);
  assert.equal(thinFeed?.average_overall_score, 3.8);
  assert.equal(thinFeed?.recommendation, "review");
  assert.equal(thinFeed?.fetch_recommendation, "keep");

  const fullFeed = review.feeds.find((entry) => entry.feed_id === "full-feed");
  assert.ok(fullFeed, "should include full feed");
  assert.equal(fullFeed?.items_offered, 1);
  assert.equal(fullFeed?.items_fetched, 0);
  // Proportional attribution: 1 item out of 2 total = 0.5 weight
  assert.equal(fullFeed?.quality_samples, 0.5);
  assert.equal(fullFeed?.average_overall_score, 3.8);
  assert.equal(fullFeed?.fetch_recommendation, "keep");
});

test("runDigestDelivery keeps low-confidence feed recommendations in review", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "feed-review-confidence-"));
  const pendingPath = path.join(dir, "feeds_pending.json");
  const qualityPath = path.join(dir, "digest_quality.jsonl");
  const sourceReviewPath = path.join(dir, "feed_source_review.json");
  const feedsPath = path.join(dir, "feeds.json");
  const logger = createLogger();
  const queue = new JobQueue();
  const bot = createBot();

  writeFileSync(feedsPath, JSON.stringify([
    {
      id: "weak-feed",
      name: "Weak Feed",
      fetch_hint: "auto",
      content_quality: "thin-snippet",
    },
    {
      id: "strong-feed",
      name: "Strong Feed",
      fetch_hint: "auto",
      content_quality: "full-text",
    },
  ], null, 2));

  writeFileSync(sourceReviewPath, JSON.stringify({
    generated_at: new Date(0).toISOString(),
    feeds: [
      {
        feed_id: "weak-feed",
        feed_name: "Weak Feed",
        fetch_hint: "auto",
        content_quality: "thin-snippet",
        items_offered: 6,
        digests_included: 6,
        items_fetched: 0,
        last_seen_at: new Date(0).toISOString(),
        average_scores: {
          relevance: 1,
          depth: 2,
          originality: 2,
          connections: 1.5,
          tool_efficiency: 1,
        },
        average_overall_score: 1.5,
        recommendation: "candidate_disable",
        fetch_recommendation: "keep",
        quality_samples: 2,
      },
      {
        feed_id: "strong-feed",
        feed_name: "Strong Feed",
        fetch_hint: "auto",
        content_quality: "full-text",
        items_offered: 4,
        digests_included: 4,
        items_fetched: 2,
        last_seen_at: new Date(0).toISOString(),
        average_scores: {
          relevance: 5,
          depth: 4,
          originality: 4,
          connections: 4,
          tool_efficiency: 4,
        },
        average_overall_score: 4.2,
        recommendation: "keep",
        fetch_recommendation: "keep",
        quality_samples: 1,
      },
    ],
  }, null, 2), "utf-8");

  savePendingItems([
    {
      feed_id: "weak-feed",
      feed_name: "Weak Feed",
      title: "Weak Post",
      url: "https://example.com/weak",
      snippet: "Weak snippet",
    },
    {
      feed_id: "strong-feed",
      feed_name: "Strong Feed",
      title: "Strong Post",
      url: "https://example.com/strong",
      snippet: "Strong snippet",
    },
  ], pendingPath);

  await runDigestDelivery({
    feedsConfig: createFeedsConfig(),
    jobQueue: queue,
    agent: createAgentWithToolTelemetry({
      evaluation: {
        scores: {
          relevance: 4,
          depth: 4,
          originality: 4,
          connections: 4,
          tool_efficiency: 4,
        },
        summary: "Solid mixed digest.",
        confidence: "low",
        suspicious_reasons: ["all_scores_equal"],
      },
    }),
    bot,
    log: logger,
    pendingPath,
    feedsPath,
    qualityPath,
    sourceReviewPath,
  });

  const review = JSON.parse(readFileSync(sourceReviewPath, "utf-8")) as {
    feeds: Array<{
      feed_id: string;
      recommendation: string;
    }>;
  };

  const weakFeed = review.feeds.find((entry) => entry.feed_id === "weak-feed");
  const strongFeed = review.feeds.find((entry) => entry.feed_id === "strong-feed");
  assert.equal(weakFeed?.recommendation, "review");
  assert.equal(strongFeed?.recommendation, "review");
});

test("runDigestDelivery excludes low-confidence evaluations from feed review score accumulation", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "feed-review-low-confidence-"));
  const pendingPath = path.join(dir, "feeds_pending.json");
  const qualityPath = path.join(dir, "digest_quality.jsonl");
  const sourceReviewPath = path.join(dir, "feed_source_review.json");
  const feedsPath = path.join(dir, "feeds.json");
  const logger = createLogger();
  const queue = new JobQueue();
  const bot = createBot();

  writeFileSync(feedsPath, JSON.stringify([
    {
      id: "thin-feed",
      name: "Thin Feed",
      fetch_hint: "auto",
      content_quality: "thin-snippet",
    },
  ], null, 2));

  writeFileSync(sourceReviewPath, JSON.stringify({
    generated_at: new Date(0).toISOString(),
    feeds: [
      {
        feed_id: "thin-feed",
        feed_name: "Thin Feed",
        fetch_hint: "auto",
        content_quality: "thin-snippet",
        items_offered: 1,
        digests_included: 1,
        items_fetched: 0,
        last_seen_at: new Date(0).toISOString(),
        average_scores: {
          relevance: 4,
          depth: 4,
          originality: 4,
          connections: 4,
          tool_efficiency: 4,
        },
        average_overall_score: 4,
        recommendation: "review",
        fetch_recommendation: "keep",
        quality_samples: 1,
      },
    ],
  }, null, 2), "utf-8");

  savePendingItems([
    {
      feed_id: "thin-feed",
      feed_name: "Thin Feed",
      title: "Post 2",
      url: "https://example.com/2",
      snippet: "Another snippet",
    },
  ], pendingPath);

  await runDigestDelivery({
    feedsConfig: createFeedsConfig(),
    jobQueue: queue,
    agent: createAgentWithToolTelemetry({
      evaluation: {
        scores: {
          relevance: 1,
          depth: 1,
          originality: 1,
          connections: 1,
          tool_efficiency: 1,
        },
        summary: "Repaired summary",
        confidence: "low",
        suspicious_reasons: ["placeholder_summary"],
      },
    }),
    bot,
    log: logger,
    pendingPath,
    feedsPath,
    qualityPath,
    sourceReviewPath,
  });

  const review = JSON.parse(readFileSync(sourceReviewPath, "utf-8")) as {
    feeds: Array<{
      feed_id: string;
      items_offered: number;
      digests_included: number;
      quality_samples: number;
      average_overall_score: number | null;
      quality_score_sums: {
        relevance: number;
        depth: number;
        originality: number;
        connections: number;
        tool_efficiency: number;
      };
    }>;
  };

  const thinFeed = review.feeds.find((entry) => entry.feed_id === "thin-feed");
  assert.ok(thinFeed);
  assert.equal(thinFeed?.items_offered, 2);
  assert.equal(thinFeed?.digests_included, 2);
  assert.equal(thinFeed?.quality_samples, 1);
  assert.equal(thinFeed?.average_overall_score, 4);
  assert.deepEqual(thinFeed?.quality_score_sums, {
    relevance: 4,
    depth: 4,
    originality: 4,
    connections: 4,
    tool_efficiency: 4,
  });

  const qualityLines = readFileSync(qualityPath, "utf-8").trim().split("\n");
  assert.equal(qualityLines.length, 1);
  const qualityRecord = JSON.parse(qualityLines[0]) as {
    confidence?: string;
    suspicious_reasons?: string[];
  };
  assert.equal(qualityRecord.confidence, "low");
  assert.deepEqual(qualityRecord.suspicious_reasons, ["placeholder_summary"]);
});

test("runDigestDelivery recommends always-fetch only after repeated fetching", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "feed-review-fetch-threshold-"));
  const pendingPath = path.join(dir, "feeds_pending.json");
  const qualityPath = path.join(dir, "digest_quality.jsonl");
  const sourceReviewPath = path.join(dir, "feed_source_review.json");
  const feedsPath = path.join(dir, "feeds.json");
  const logger = createLogger();
  const queue = new JobQueue();
  const bot = createBot();

  writeFileSync(feedsPath, JSON.stringify([
    {
      id: "repeat-fetch-feed",
      name: "Repeat Fetch Feed",
      fetch_hint: "auto",
      content_quality: "thin-snippet",
    },
  ], null, 2));

  writeFileSync(sourceReviewPath, JSON.stringify({
    generated_at: new Date(0).toISOString(),
    feeds: [
      {
        feed_id: "repeat-fetch-feed",
        feed_name: "Repeat Fetch Feed",
        fetch_hint: "auto",
        content_quality: "thin-snippet",
        items_offered: 2,
        digests_included: 2,
        items_fetched: 2,
        last_seen_at: new Date(0).toISOString(),
        average_scores: null,
        average_overall_score: null,
        recommendation: "review",
        fetch_recommendation: "keep",
        quality_samples: 0,
      },
    ],
  }, null, 2), "utf-8");

  savePendingItems([
    {
      feed_id: "repeat-fetch-feed",
      feed_name: "Repeat Fetch Feed",
      title: "Fetch Me",
      url: "https://example.com/fetch-me",
      snippet: "Thin snippet",
    },
  ], pendingPath);

  await runDigestDelivery({
    feedsConfig: createFeedsConfig(),
    jobQueue: queue,
    agent: createAgentWithToolTelemetry({
      toolCalls: [{ name: "web_fetch", args: { url: "https://example.com/fetch-me" } }],
      evaluation: {
        scores: {
          relevance: 4,
          depth: 4,
          originality: 4,
          connections: 4,
          tool_efficiency: 4,
        },
        summary: "Fetched again.",
      },
    }),
    bot,
    log: logger,
    pendingPath,
    feedsPath,
    qualityPath,
    sourceReviewPath,
  });

  const review = JSON.parse(readFileSync(sourceReviewPath, "utf-8")) as {
    feeds: Array<{
      feed_id: string;
      items_offered: number;
      items_fetched: number;
      fetch_recommendation: string;
    }>;
  };

  const repeatFetchFeed = review.feeds.find((entry) => entry.feed_id === "repeat-fetch-feed");
  assert.equal(repeatFetchFeed?.items_offered, 3);
  assert.equal(repeatFetchFeed?.items_fetched, 3);
  assert.equal(repeatFetchFeed?.fetch_recommendation, "consider_always");
});

test("runDigestDelivery preserves per-feed quality accumulators across multiple single-feed digests", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "feed-review-persist-"));
  const pendingPath = path.join(dir, "feeds_pending.json");
  const qualityPath = path.join(dir, "digest_quality.jsonl");
  const sourceReviewPath = path.join(dir, "feed_source_review.json");
  const feedsPath = path.join(dir, "feeds.json");
  const logger = createLogger();
  const queue = new JobQueue();
  const bot = createBot();

  writeFileSync(feedsPath, JSON.stringify([
    {
      id: "thin-feed",
      name: "Thin Feed",
      fetch_hint: "auto",
      content_quality: "thin-snippet",
    },
  ], null, 2));

  savePendingItems([
    {
      feed_id: "thin-feed",
      feed_name: "Thin Feed",
      title: "Post 1",
      url: "https://example.com/1",
      snippet: "Thin snippet",
    },
  ], pendingPath);

  await runDigestDelivery({
    feedsConfig: createFeedsConfig(),
    jobQueue: queue,
    agent: createAgentWithToolTelemetry({
      evaluation: {
        scores: {
          relevance: 4,
          depth: 4,
          originality: 4,
          connections: 4,
          tool_efficiency: 4,
        },
        summary: "Strong first digest.",
      },
    }),
    bot,
    log: logger,
    pendingPath,
    feedsPath,
    qualityPath,
    sourceReviewPath,
  });

  savePendingItems([
    {
      feed_id: "thin-feed",
      feed_name: "Thin Feed",
      title: "Post 2",
      url: "https://example.com/2",
      snippet: "Another snippet",
    },
  ], pendingPath);

  await runDigestDelivery({
    feedsConfig: createFeedsConfig(),
    jobQueue: queue,
    agent: createAgentWithToolTelemetry({
      evaluation: {
        scores: {
          relevance: 2,
          depth: 2,
          originality: 2,
          connections: 2,
          tool_efficiency: 2,
        },
        summary: "Weaker follow-up digest.",
      },
    }),
    bot,
    log: logger,
    pendingPath,
    feedsPath,
    qualityPath,
    sourceReviewPath,
  });

  const review = JSON.parse(readFileSync(sourceReviewPath, "utf-8")) as {
    feeds: Array<{
      feed_id: string;
      items_offered: number;
      digests_included: number;
      quality_samples: number;
      average_overall_score: number | null;
      quality_score_sums: {
        relevance: number;
        depth: number;
        originality: number;
        connections: number;
        tool_efficiency: number;
      };
    }>;
  };

  const thinFeed = review.feeds.find((entry) => entry.feed_id === "thin-feed");
  assert.ok(thinFeed, "should include the tracked feed");
  assert.equal(thinFeed?.items_offered, 2);
  assert.equal(thinFeed?.digests_included, 2);
  assert.equal(thinFeed?.quality_samples, 2);
  assert.equal(thinFeed?.average_overall_score, 3);
  assert.deepEqual(thinFeed?.quality_score_sums, {
    relevance: 6,
    depth: 6,
    originality: 6,
    connections: 6,
    tool_efficiency: 6,
  });
});

test("runDigestDelivery carries legacy feed review averages forward when updating", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "feed-review-legacy-"));
  const pendingPath = path.join(dir, "feeds_pending.json");
  const qualityPath = path.join(dir, "digest_quality.jsonl");
  const sourceReviewPath = path.join(dir, "feed_source_review.json");
  const feedsPath = path.join(dir, "feeds.json");
  const logger = createLogger();
  const queue = new JobQueue();
  const bot = createBot();

  writeFileSync(feedsPath, JSON.stringify([
    {
      id: "thin-feed",
      name: "Thin Feed",
      fetch_hint: "auto",
      content_quality: "thin-snippet",
    },
  ], null, 2));

  writeFileSync(sourceReviewPath, JSON.stringify({
    generated_at: new Date(0).toISOString(),
    feeds: [
      {
        feed_id: "thin-feed",
        feed_name: "Thin Feed",
        fetch_hint: "auto",
        content_quality: "thin-snippet",
        items_offered: 1,
        digests_included: 1,
        items_fetched: 0,
        last_seen_at: new Date(0).toISOString(),
        average_scores: {
          relevance: 4,
          depth: 4,
          originality: 4,
          connections: 4,
          tool_efficiency: 4,
        },
        average_overall_score: 4,
        recommendation: "review",
        fetch_recommendation: "keep",
        quality_samples: 1,
      },
    ],
  }, null, 2), "utf-8");

  savePendingItems([
    {
      feed_id: "thin-feed",
      feed_name: "Thin Feed",
      title: "Post 2",
      url: "https://example.com/2",
      snippet: "Another snippet",
    },
  ], pendingPath);

  await runDigestDelivery({
    feedsConfig: createFeedsConfig(),
    jobQueue: queue,
    agent: createAgentWithToolTelemetry({
      evaluation: {
        scores: {
          relevance: 2,
          depth: 2,
          originality: 2,
          connections: 2,
          tool_efficiency: 2,
        },
        summary: "Weaker follow-up digest.",
      },
    }),
    bot,
    log: logger,
    pendingPath,
    feedsPath,
    qualityPath,
    sourceReviewPath,
  });

  const review = JSON.parse(readFileSync(sourceReviewPath, "utf-8")) as {
    feeds: Array<{
      feed_id: string;
      quality_samples: number;
      average_overall_score: number | null;
      quality_score_sums: {
        relevance: number;
        depth: number;
        originality: number;
        connections: number;
        tool_efficiency: number;
      };
    }>;
  };

  const thinFeed = review.feeds.find((entry) => entry.feed_id === "thin-feed");
  assert.ok(thinFeed, "should preserve the legacy feed");
  assert.equal(thinFeed?.quality_samples, 2);
  assert.equal(thinFeed?.average_overall_score, 3);
  assert.deepEqual(thinFeed?.quality_score_sums, {
    relevance: 6,
    depth: 6,
    originality: 6,
    connections: 6,
    tool_efficiency: 6,
  });
});

test("runDigestDelivery does nothing when no items are pending", async () => {
  const logger = createLogger();
  const queue = new JobQueue();
  const agent = createAgent();
  const bot = createBot();
  const pendingPath = createTempPendingPath();

  await runDigestDelivery({
    feedsConfig: createFeedsConfig(),
    jobQueue: queue,
    agent,
    bot,
    log: logger,
    pendingPath,
  });

  assert.deepEqual(agent.prompts, []);
  assert.deepEqual(bot.sent, []);
  assert.ok(logger.logs.some((l) => l.includes("nothing pending")));
});

test("isDigestTime returns true at configured times", () => {
  const result = isDigestTime(["09:00", "13:00", "18:00"], () => ({ hour: 9, minute: 0 }));
  assert.equal(result, true);

  const result2 = isDigestTime(["09:00", "13:00", "18:00"], () => ({ hour: 18, minute: 0 }));
  assert.equal(result2, true);
});

test("isDigestTime returns false at non-configured times", () => {
  const result = isDigestTime(["09:00", "13:00", "18:00"], () => ({ hour: 10, minute: 30 }));
  assert.equal(result, false);

  const result2 = isDigestTime(["09:00", "13:00", "18:00"], () => ({ hour: 9, minute: 1 }));
  assert.equal(result2, false);
});

// ── Digest archive tests ──────────────────────────────────────────

function createArchiveEntry(overrides: Partial<DigestArchiveEntry> = {}): DigestArchiveEntry {
  return {
    timestamp: new Date().toISOString(),
    digest_text: "Test digest content about AI developments.",
    context: {
      timestamp: new Date().toISOString(),
      topics: ["AI", "crypto"],
      entities: ["OpenAI", "Anthropic"],
      sentiment: "bullish",
      summary: "AI developments continue to accelerate",
      interests_served: ["AI/ML"],
    },
    items_offered: 5,
    feed_ids: ["feed-a", "feed-b"],
    ...overrides,
  };
}

test("loadDigestArchive returns empty array for missing file", () => {
  const result = loadDigestArchive("/nonexistent/path.json");
  assert.deepEqual(result, []);
});

test("saveDigestArchive and loadDigestArchive round-trip", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "archive-"));
  const archivePath = path.join(tmp, "digest_archive.json");

  const entries = [createArchiveEntry(), createArchiveEntry({ digest_text: "Second digest" })];
  saveDigestArchive(archivePath, entries);

  const loaded = loadDigestArchive(archivePath);
  assert.equal(loaded.length, 2);
  assert.equal(loaded[1].digest_text, "Second digest");
});

test("saveDigestArchive trims to MAX entries", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "archive-"));
  const archivePath = path.join(tmp, "digest_archive.json");

  // Create 70 entries (MAX is 60)
  const entries = Array.from({ length: 70 }, (_, i) =>
    createArchiveEntry({ digest_text: `Digest ${i}` }),
  );
  saveDigestArchive(archivePath, entries);

  const loaded = loadDigestArchive(archivePath);
  assert.equal(loaded.length, 60);
  assert.equal(loaded[0].digest_text, "Digest 10"); // first 10 trimmed
});

test("appendDigestArchive adds to existing archive", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "archive-"));
  const archivePath = path.join(tmp, "digest_archive.json");

  appendDigestArchive(archivePath, createArchiveEntry({ digest_text: "First" }));
  appendDigestArchive(archivePath, createArchiveEntry({ digest_text: "Second" }));

  const loaded = loadDigestArchive(archivePath);
  assert.equal(loaded.length, 2);
  assert.equal(loaded[0].digest_text, "First");
  assert.equal(loaded[1].digest_text, "Second");
});

// ── Weekly synthesis prompt tests ─────────────────────────────────

test("buildWeeklySynthesisPrompt includes digest count and all sections", () => {
  const archive = [
    createArchiveEntry({ timestamp: "2026-03-21T09:00:00Z" }),
    createArchiveEntry({ timestamp: "2026-03-22T13:00:00Z" }),
    createArchiveEntry({ timestamp: "2026-03-23T18:00:00Z" }),
  ];

  const prompt = buildWeeklySynthesisPrompt(archive, "Core: AI/ML", "Power dynamics lens");

  assert.ok(prompt.includes("3 digests"));
  assert.ok(prompt.includes("Trend Detection"));
  assert.ok(prompt.includes("Narrative Arcs"));
  assert.ok(prompt.includes("Prediction Scorecard"));
  assert.ok(prompt.includes("Interest Drift"));
  assert.ok(prompt.includes("Source Quality"));
  assert.ok(prompt.includes("Core: AI/ML"));
  assert.ok(prompt.includes("Power dynamics lens"));
  assert.ok(prompt.includes("Test digest content"));
});

test("buildWeeklySynthesisPrompt works without interests/lens", () => {
  const archive = [createArchiveEntry()];
  const prompt = buildWeeklySynthesisPrompt(archive);

  assert.ok(prompt.includes("1 digests"));
  assert.ok(prompt.includes("Trend Detection"));
  assert.ok(!prompt.includes("Your interests"));
  assert.ok(!prompt.includes("Your analytical lens"));
});

// ── isSynthesisTime tests ─────────────────────────────────────────

test("isSynthesisTime matches correct day and time", () => {
  const result = isSynthesisTime(0, "10:00", () => ({
    dayOfWeek: 0,
    hour: 10,
    minute: 0,
  }));
  assert.equal(result, true);
});

test("isSynthesisTime rejects wrong day", () => {
  const result = isSynthesisTime(0, "10:00", () => ({
    dayOfWeek: 3,
    hour: 10,
    minute: 0,
  }));
  assert.equal(result, false);
});

test("isSynthesisTime rejects wrong time", () => {
  const result = isSynthesisTime(0, "10:00", () => ({
    dayOfWeek: 0,
    hour: 11,
    minute: 0,
  }));
  assert.equal(result, false);
});

test("isSynthesisTime handles Saturday (day 6)", () => {
  const result = isSynthesisTime(6, "15:30", () => ({
    dayOfWeek: 6,
    hour: 15,
    minute: 30,
  }));
  assert.equal(result, true);
});

// ── runWeeklySynthesis tests ──────────────────────────────────────

test("runWeeklySynthesis skips when no archive path", async () => {
  const logger = createLogger();
  const queue = new JobQueue();
  const agent = createAgent();
  const bot = createBot();

  await runWeeklySynthesis({
    feedsConfig: createFeedsConfig(),
    jobQueue: queue,
    agent,
    bot,
    log: logger,
  });

  assert.ok(logger.logs.some((l) => l.includes("No archive path")));
  assert.equal(bot.sent.length, 0);
});

test("runWeeklySynthesis skips when archive is empty", async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "synth-"));
  const archivePath = path.join(tmp, "digest_archive.json");
  const logger = createLogger();
  const queue = new JobQueue();
  const agent = createAgent();
  const bot = createBot();

  await runWeeklySynthesis({
    feedsConfig: createFeedsConfig(),
    jobQueue: queue,
    agent,
    bot,
    log: logger,
    archivePath,
  });

  assert.ok(logger.logs.some((l) => l.includes("No archived digests")));
});

test("runWeeklySynthesis skips when fewer than 3 recent digests", async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "synth-"));
  const archivePath = path.join(tmp, "digest_archive.json");
  const logger = createLogger();
  const queue = new JobQueue();
  const agent = createAgent();
  const bot = createBot();

  // Two recent digests
  saveDigestArchive(archivePath, [
    createArchiveEntry({ timestamp: new Date().toISOString() }),
    createArchiveEntry({ timestamp: new Date().toISOString() }),
  ]);

  await runWeeklySynthesis({
    feedsConfig: createFeedsConfig(),
    jobQueue: queue,
    agent,
    bot,
    log: logger,
    archivePath,
  });

  assert.ok(logger.logs.some((l) => l.includes("Only 2 digests")));
});

test("runWeeklySynthesis generates and posts synthesis", async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "synth-"));
  const archivePath = path.join(tmp, "digest_archive.json");
  const logger = createLogger();
  const queue = new JobQueue();
  const agent = createAgent();
  const bot = createBot();

  // Three recent digests
  const now = Date.now();
  saveDigestArchive(archivePath, [
    createArchiveEntry({ timestamp: new Date(now - 2 * 86400000).toISOString() }),
    createArchiveEntry({ timestamp: new Date(now - 86400000).toISOString() }),
    createArchiveEntry({ timestamp: new Date(now).toISOString() }),
  ]);

  let metricsEmitted = false;
  await runWeeklySynthesis({
    feedsConfig: createFeedsConfig(),
    jobQueue: queue,
    agent,
    bot,
    digestModel: "anthropic/claude-sonnet-4-6",
    log: logger,
    archivePath,
    onSynthesisMetrics: () => { metricsEmitted = true; },
  });

  // Wait for the queued job to complete
  await new Promise((r) => setTimeout(r, 100));

  assert.ok(logger.logs.some((l) => l.includes("Running weekly synthesis over 3 digests")));
  assert.equal(bot.sent.length, 1);
  assert.ok(bot.sent[0].text.includes("Weekly Synthesis"));
  assert.equal(agent.prompts.length, 1);
  assert.ok(agent.prompts[0].includes("Trend Detection"));
});

// ── JSON format compatibility tests ─────────────────────────────

test("feed_context.json format: saveFeedContext writes expected JSON structure", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ctx-format-"));
  const contextPath = path.join(dir, "feed_context.json");

  const entries: FeedContextEntry[] = [
    {
      timestamp: "2026-03-28T10:00:00.000Z",
      topics: ["AI regulation", "open-source"],
      entities: ["OpenAI", "EU"],
      sentiment: "cautious",
      summary: "EU regulation looming over AI sector",
      interests_served: ["AI/ML", "geopolitics"],
    },
  ];

  saveFeedContext(contextPath, entries);
  const raw = readFileSync(contextPath, "utf-8");
  const parsed = JSON.parse(raw);

  // Verify top-level is an array
  assert.ok(Array.isArray(parsed), "feed_context.json must be a JSON array");
  assert.equal(parsed.length, 1);

  // Verify entry shape matches expected contract
  const entry = parsed[0];
  assert.equal(typeof entry.timestamp, "string");
  assert.ok(Array.isArray(entry.topics));
  assert.ok(Array.isArray(entry.entities));
  assert.equal(typeof entry.sentiment, "string");
  assert.equal(typeof entry.summary, "string");
  assert.ok(Array.isArray(entry.interests_served));

  // Verify round-trip: loadFeedContext can read what saveFeedContext wrote
  const loaded = loadFeedContext(contextPath);
  assert.deepEqual(loaded, entries);
});

test("feed_context.json format: loadFeedContext handles legacy entries without interests_served", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ctx-legacy-"));
  const contextPath = path.join(dir, "feed_context.json");

  // Legacy format: no interests_served field
  const legacyJson = JSON.stringify([
    {
      timestamp: "2026-03-27T09:00:00.000Z",
      topics: ["crypto"],
      entities: ["Bitcoin"],
      sentiment: "bullish",
      summary: "Bitcoin rally continues",
    },
  ]);

  writeFileSync(contextPath, legacyJson, "utf-8");
  const loaded = loadFeedContext(contextPath);

  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].summary, "Bitcoin rally continues");
  // interests_served should be undefined (not crash)
  assert.equal(loaded[0].interests_served, undefined);
});

test("digest_archive.json format: saveDigestArchive writes expected JSON structure", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "archive-format-"));
  const archivePath = path.join(dir, "digest_archive.json");

  const entries: DigestArchiveEntry[] = [
    {
      timestamp: "2026-03-28T10:00:00.000Z",
      digest_text: "Here's what happened today...",
      context: {
        timestamp: "2026-03-28T10:00:00.000Z",
        topics: ["AI"],
        entities: ["Anthropic"],
        sentiment: "excited",
        summary: "New model release",
        interests_served: ["AI/ML"],
      },
      items_offered: 5,
      feed_ids: ["hn", "ars"],
    },
  ];

  saveDigestArchive(archivePath, entries);
  const raw = readFileSync(archivePath, "utf-8");
  const parsed = JSON.parse(raw);

  // Verify top-level is an array
  assert.ok(Array.isArray(parsed));
  assert.equal(parsed.length, 1);

  // Verify entry shape
  const entry = parsed[0];
  assert.equal(typeof entry.timestamp, "string");
  assert.equal(typeof entry.digest_text, "string");
  assert.ok(typeof entry.context === "object" && entry.context !== null);
  assert.equal(typeof entry.items_offered, "number");
  assert.ok(Array.isArray(entry.feed_ids));

  // Verify context sub-object
  assert.ok(Array.isArray(entry.context.topics));
  assert.ok(Array.isArray(entry.context.entities));
  assert.equal(typeof entry.context.sentiment, "string");

  // Round-trip
  const loaded = loadDigestArchive(archivePath);
  assert.deepEqual(loaded, entries);
});

test("pending items format: savePendingItems writes expected JSON array", () => {
  const pendingPath = createTempPendingPath();

  const items = [
    { feed_id: "hn", feed_name: "Hacker News", title: "Post 1", url: "https://hn.com/1", snippet: "A snippet" },
    { feed_id: "ars", feed_name: "Ars Technica", title: "Post 2", url: "https://ars.com/2", snippet: null },
  ];

  savePendingItems(items, pendingPath);
  const raw = readFileSync(pendingPath, "utf-8");
  const parsed = JSON.parse(raw);

  assert.ok(Array.isArray(parsed));
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].feed_id, "hn");
  assert.equal(parsed[0].snippet, "A snippet");
  assert.equal(parsed[1].snippet, null);

  // Round-trip
  const loaded = loadPendingItems(pendingPath);
  assert.deepEqual(loaded, items);
});
