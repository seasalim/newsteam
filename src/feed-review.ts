/**
 * Feed source review: tracks per-feed quality metrics across digests
 * and generates keep/review/disable recommendations.
 */

import fs from "node:fs";
import path from "node:path";

import type { DigestQualityEvaluation } from "./agent.ts";
import type {
  FeedContentQuality,
  FeedFetchHint,
  FeedItem,
  FeedRegistryMetadata,
} from "./feeds.ts";
import {
  isObjectRecord,
  normalizeComparableUrl,
  normalizeContentQuality,
  normalizeFetchHint,
  sanitizeFeedText,
} from "./feeds.ts";

// ── Types ────────────────────────────────────────────────────────

type FeedSourceReviewEntry = {
  feed_id: string;
  feed_name: string;
  fetch_hint: FeedFetchHint;
  content_quality: FeedContentQuality;
  items_offered: number;
  digests_included: number;
  items_fetched: number;
  last_seen_at: string;
  average_scores: DigestQualityEvaluation["scores"] | null;
  average_overall_score: number | null;
  recommendation: "keep" | "review" | "candidate_disable";
  fetch_recommendation: "keep" | "consider_always" | "consider_auto";
  quality_samples: number;
  quality_score_sums: DigestQualityEvaluation["scores"];
};

type FeedSourceReviewFile = {
  generated_at: string;
  feeds: FeedSourceReviewEntry[];
};

type FeedSourceReviewAccumulator = {
  feed_id: string;
  feed_name: string;
  fetch_hint: FeedFetchHint;
  content_quality: FeedContentQuality;
  items_offered: number;
  digests_included: number;
  items_fetched: number;
  last_seen_at: string;
  quality_samples: number;
  quality_score_sums: DigestQualityEvaluation["scores"];
};

// ── Loading ──────────────────────────────────────────────────────

function loadFeedSourceReview(filePath: string): FeedSourceReviewAccumulator[] {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as { feeds?: Array<Record<string, unknown>> };
    if (!Array.isArray(parsed.feeds)) return [];

    return parsed.feeds
      .filter((entry) => isObjectRecord(entry) && typeof entry.feed_id === "string" && typeof entry.feed_name === "string")
      .map((entry) => {
        const qualitySamples = Number(entry.quality_samples) || 0;
        const rawSums = (entry as { quality_score_sums?: Record<string, unknown> }).quality_score_sums;
        const legacyAverages = (entry as { average_scores?: Record<string, unknown> }).average_scores;
        const toScoreSum = (key: keyof DigestQualityEvaluation["scores"]): number => {
          const explicit = Number(rawSums?.[key]);
          if (Number.isFinite(explicit)) {
            return explicit;
          }

          const legacyAverage = Number(legacyAverages?.[key]);
          if (qualitySamples > 0 && Number.isFinite(legacyAverage)) {
            return legacyAverage * qualitySamples;
          }

          return 0;
        };

        return {
          feed_id: String(entry.feed_id),
          feed_name: String(entry.feed_name),
          fetch_hint: normalizeFetchHint(entry.fetch_hint),
          content_quality: normalizeContentQuality(entry.content_quality),
          items_offered: Number(entry.items_offered) || 0,
          digests_included: Number(entry.digests_included) || 0,
          items_fetched: Number(entry.items_fetched) || 0,
          last_seen_at: typeof entry.last_seen_at === "string" ? entry.last_seen_at : new Date(0).toISOString(),
          quality_samples: qualitySamples,
          quality_score_sums: {
            relevance: toScoreSum("relevance"),
            depth: toScoreSum("depth"),
            originality: toScoreSum("originality"),
            connections: toScoreSum("connections"),
            tool_efficiency: toScoreSum("tool_efficiency"),
          },
        };
      });
  } catch {
    return [];
  }
}

// ── Recommendations ──────────────────────────────────────────────

function getFeedRecommendation(entry: FeedSourceReviewEntry): FeedSourceReviewEntry["recommendation"] {
  // With proportional attribution, quality_samples is fractional — require
  // the equivalent of at least 3 full digests of accumulated weight.
  if (entry.quality_samples < 3 || entry.average_overall_score === null) {
    return "review";
  }

  if (entry.average_overall_score >= 3.0) {
    return "keep";
  }

  if (entry.average_overall_score < 2.5 && entry.items_fetched === 0) {
    return "candidate_disable";
  }

  return "review";
}

function getFetchRecommendation(entry: FeedSourceReviewEntry): FeedSourceReviewEntry["fetch_recommendation"] {
  if (entry.items_offered < 3) return "keep";

  const fetchRate = entry.items_fetched / entry.items_offered;
  if (fetchRate >= 0.6 && entry.fetch_hint !== "always") {
    return "consider_always";
  }

  if (fetchRate === 0 && entry.fetch_hint === "always") {
    return "consider_auto";
  }

  return "keep";
}

function isHighConfidenceEvaluation(
  evaluation: DigestQualityEvaluation | null | undefined,
): evaluation is DigestQualityEvaluation {
  return Boolean(evaluation && evaluation.confidence !== "low");
}

// ── Update ───────────────────────────────────────────────────────

export function updateFeedSourceReview(options: {
  reviewPath: string;
  items: FeedItem[];
  fetchedItems: FeedItem[];
  evaluation?: DigestQualityEvaluation | null;
  feedMetadata: ReadonlyMap<string, FeedRegistryMetadata>;
}): void {
  const existing = loadFeedSourceReview(options.reviewPath);
  const byFeedId = new Map(existing.map((entry) => [entry.feed_id, entry]));
  const now = new Date().toISOString();
  const fetchedItemUrls = new Set(options.fetchedItems.map((item) => normalizeComparableUrl(item.url)));
  const feedsSeenThisDigest = new Set<string>();

  // Count items per feed so we can weight quality attribution proportionally.
  const itemsPerFeed = new Map<string, number>();
  for (const item of options.items) {
    const feedId = item.feed_id ?? "unknown";
    itemsPerFeed.set(feedId, (itemsPerFeed.get(feedId) ?? 0) + 1);
  }
  const totalItems = options.items.length;

  for (const item of options.items) {
    const feedId = item.feed_id ?? "unknown";
    const metadata = item.feed_id ? options.feedMetadata.get(item.feed_id) : undefined;
    const entry = byFeedId.get(feedId) ?? {
      feed_id: feedId,
      feed_name: sanitizeFeedText(item.feed_name, feedId),
      fetch_hint: metadata?.fetchHint ?? "auto",
      content_quality: metadata?.contentQuality ?? "unknown",
      items_offered: 0,
      digests_included: 0,
      items_fetched: 0,
      last_seen_at: now,
      quality_samples: 0,
      quality_score_sums: {
        relevance: 0,
        depth: 0,
        originality: 0,
        connections: 0,
        tool_efficiency: 0,
      },
    };

    entry.feed_name = sanitizeFeedText(item.feed_name, entry.feed_name);
    entry.fetch_hint = metadata?.fetchHint ?? entry.fetch_hint;
    entry.content_quality = metadata?.contentQuality ?? entry.content_quality;
    entry.items_offered += 1;
    if (fetchedItemUrls.has(normalizeComparableUrl(item.url))) {
      entry.items_fetched += 1;
    }
    entry.last_seen_at = now;

    if (!feedsSeenThisDigest.has(feedId)) {
      entry.digests_included += 1;
      feedsSeenThisDigest.add(feedId);

      // Attribute quality scores proportionally by item share in the digest.
      if (isHighConfidenceEvaluation(options.evaluation) && totalItems > 0) {
        const weight = (itemsPerFeed.get(feedId) ?? 0) / totalItems;
        entry.quality_samples += weight;
        entry.quality_score_sums.relevance += options.evaluation.scores.relevance * weight;
        entry.quality_score_sums.depth += options.evaluation.scores.depth * weight;
        entry.quality_score_sums.originality += options.evaluation.scores.originality * weight;
        entry.quality_score_sums.connections += options.evaluation.scores.connections * weight;
        entry.quality_score_sums.tool_efficiency += options.evaluation.scores.tool_efficiency * weight;
      }
    }

    byFeedId.set(feedId, entry);
  }

  const feeds: FeedSourceReviewEntry[] = [...byFeedId.values()]
    .map((entry) => {
      const averageScores = entry.quality_samples > 0
        ? {
          relevance: Number((entry.quality_score_sums.relevance / entry.quality_samples).toFixed(2)),
          depth: Number((entry.quality_score_sums.depth / entry.quality_samples).toFixed(2)),
          originality: Number((entry.quality_score_sums.originality / entry.quality_samples).toFixed(2)),
          connections: Number((entry.quality_score_sums.connections / entry.quality_samples).toFixed(2)),
          tool_efficiency: Number((entry.quality_score_sums.tool_efficiency / entry.quality_samples).toFixed(2)),
        }
        : null;
      const averageOverallScore = averageScores
        ? Number(((averageScores.relevance + averageScores.depth + averageScores.originality + averageScores.connections + averageScores.tool_efficiency) / 5).toFixed(2))
        : null;

      const output: FeedSourceReviewEntry = {
        feed_id: entry.feed_id,
        feed_name: entry.feed_name,
        fetch_hint: entry.fetch_hint,
        content_quality: entry.content_quality,
        items_offered: entry.items_offered,
        digests_included: entry.digests_included,
        items_fetched: entry.items_fetched,
        last_seen_at: entry.last_seen_at,
        average_scores: averageScores,
        average_overall_score: averageOverallScore,
        quality_samples: entry.quality_samples,
        quality_score_sums: {
          relevance: entry.quality_score_sums.relevance,
          depth: entry.quality_score_sums.depth,
          originality: entry.quality_score_sums.originality,
          connections: entry.quality_score_sums.connections,
          tool_efficiency: entry.quality_score_sums.tool_efficiency,
        },
        recommendation: "review",
        fetch_recommendation: "keep",
      };

      output.recommendation = getFeedRecommendation(output);
      output.fetch_recommendation = getFetchRecommendation(output);
      return output;
    })
    .sort((left, right) => left.feed_id.localeCompare(right.feed_id));

  const dir = path.dirname(options.reviewPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${options.reviewPath}.tmp`;
  const file: FeedSourceReviewFile = {
    generated_at: now,
    feeds,
  };
  fs.writeFileSync(tmpPath, JSON.stringify(file, null, 2), "utf-8");
  fs.renameSync(tmpPath, options.reviewPath);
}
