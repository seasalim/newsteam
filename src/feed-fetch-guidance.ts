/**
 * Fetch guidance for digest prompts: per-feed web_fetch hints derived
 * from feeds.json metadata and large-digest fetch expectations.
 *
 * Extracted from feed-digest.ts to keep files under 500 lines.
 */

import type { FeedItem, FeedRegistryMetadata } from "./feeds.ts";

export function sanitizeFeedUrl(value: string | undefined): string {
  if (typeof value !== "string") {
    return "";
  }

  const trimmed = value.trim();
  return trimmed.startsWith("http://") || trimmed.startsWith("https://") ? trimmed : "";
}

function formatFetchGuidance(metadata: FeedRegistryMetadata): string {
  const parts: string[] = [];

  if (metadata.fetchHint === "always") {
    parts.push("fetch before making strong claims");
  } else if (metadata.fetchHint === "never") {
    parts.push("usually skip fetching unless the item is unusually important or still unclear");
  } else {
    parts.push("use normal judgment on whether to fetch");
  }

  if (metadata.contentQuality === "thin-snippet") {
    parts.push("snippet quality is usually thin");
  } else if (metadata.contentQuality === "partial") {
    parts.push("feed content is usually partial");
  } else if (metadata.contentQuality === "full-text") {
    parts.push("feed content is usually close to full text");
  }

  return parts.join("; ");
}

export function buildFetchGuidanceSection(
  items: FeedItem[],
  feedMetadata?: ReadonlyMap<string, FeedRegistryMetadata>,
): string {
  if (!feedMetadata || feedMetadata.size === 0) return "";

  const lines = [
    "## Feed-specific fetch hints",
    "Use these source-specific hints when deciding whether to call `web_fetch`:",
    "",
  ];

  const seen = new Set<string>();
  for (const item of items) {
    const feedId = item.feed_id;
    if (!feedId || seen.has(feedId)) continue;
    seen.add(feedId);

    const metadata = feedMetadata.get(feedId);
    if (!metadata) continue;
    if (metadata.fetchHint === "auto" && metadata.contentQuality === "unknown") continue;

    lines.push(`- ${metadata.name} (\`${feedId}\`): ${formatFetchGuidance(metadata)}`);
  }

  return lines.length > 3 ? lines.join("\n") : "";
}

export function buildItemFetchHintLine(
  item: FeedItem,
  feedMetadata?: ReadonlyMap<string, FeedRegistryMetadata>,
): string | null {
  if (!item.feed_id || !feedMetadata) return null;

  const metadata = feedMetadata.get(item.feed_id);
  if (!metadata) return null;
  if (metadata.fetchHint === "auto" && metadata.contentQuality === "unknown") return null;

  return `Fetch hint: ${metadata.fetchHint}; content quality: ${metadata.contentQuality}.`;
}

function hasThinSnippetFeeds(
  items: FeedItem[],
  feedMetadata?: ReadonlyMap<string, FeedRegistryMetadata>,
): boolean {
  if (!feedMetadata) return false;

  return items.some((item) => {
    const feedId = item.feed_id;
    return Boolean(feedId && feedMetadata.get(feedId)?.contentQuality === "thin-snippet");
  });
}

export function buildLargeDigestFetchSection(
  items: FeedItem[],
  feedMetadata?: ReadonlyMap<string, FeedRegistryMetadata>,
): string {
  if (items.length <= 15) return "";

  const prioritizeThinSnippetFeeds = hasThinSnippetFeeds(items, feedMetadata)
    ? " Prioritize feeds marked `thin-snippet` when deciding where a fetch will buy you the most grounding."
    : "";

  return [
    "## Large-digest fetch expectation",
    `This digest has ${items.length} items. On digests this large, zero fetches is usually a miss unless the snippets already contain enough concrete detail for your strongest claims.`,
    `Aim to fetch 2-5 of the most important or ambiguous items before making confident analytical claims.${prioritizeThinSnippetFeeds}`,
    "If you decide not to fetch anything, keep the analysis narrow and explicitly grounded in what the snippets actually say.",
  ].join("\n");
}

export function isLargeDigestZeroFetch(itemsOffered: number, itemsFetched: number): boolean {
  return itemsOffered > 15 && itemsFetched === 0;
}
