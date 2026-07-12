/**
 * Weekly synthesis: meta-analysis across recent daily digests.
 * Covers trend detection, narrative arcs, prediction scorecard,
 * interest drift, and source quality.
 */

import type { FeedsConfig } from "./config.ts";
import {
  type DigestArchiveEntry,
  buildInterestsSection,
  buildLensSection,
  loadDigestArchive,
  loadInterests,
  loadLens,
} from "./feed-context.ts";
import { PACIFIC_TIME_ZONE } from "./feeds.ts";
import type { JobQueue } from "./scheduler.ts";

// ── Types ────────────────────────────────────────────────────────

type Usage = {
  inputTokens: number;
  outputTokens: number;
};

type SynthesisAgent = {
  chat: (message: string, channelId?: string, options?: { maxTurns?: number; model?: string }) => Promise<{ content: string; usage: Usage }>;
  clearWindow: () => void;
  getBudgetStats?: () => { toolCalls: number; toolUsage: Record<string, number>; costCents: number; turns: number };
};

type SynthesisBot = {
  sendToChannel: (channelId: string, text: string) => Promise<void>;
};

type SynthesisLogger = Pick<Console, "log" | "error">;

export type SynthesisMetrics = {
  digests_analyzed: number;
  period_days: number;
  input_tokens: number;
  output_tokens: number;
  cost_cents: number;
  response_length: number;
  model?: string;
};

// ── Digest formatting ────────────────────────────────────────────

function formatDigestFull(entry: DigestArchiveEntry): string {
  const date = entry.timestamp.slice(0, 10);
  const time = entry.timestamp.slice(11, 16);
  return [
    `### ${date} ${time}`,
    `**Topics:** ${entry.context.topics.join(", ") || "none"}`,
    `**Entities:** ${entry.context.entities.join(", ") || "none"}`,
    `**Sentiment:** ${entry.context.sentiment}`,
    `**Interests served:** ${(entry.context.interests_served ?? []).join(", ") || "none"}`,
    `**Items offered:** ${entry.items_offered} from feeds: ${entry.feed_ids.join(", ")}`,
    "",
    entry.digest_text,
    "",
  ].join("\n");
}

function formatDigestCompact(entry: DigestArchiveEntry): string {
  const date = entry.timestamp.slice(0, 10);
  const time = entry.timestamp.slice(11, 16);
  return [
    `### ${date} ${time} *(summary only)*`,
    `**Topics:** ${entry.context.topics.join(", ") || "none"}`,
    `**Entities:** ${entry.context.entities.join(", ") || "none"}`,
    `**Sentiment:** ${entry.context.sentiment}`,
    `**Summary:** ${entry.context.summary}`,
    `**Interests served:** ${(entry.context.interests_served ?? []).join(", ") || "none"}`,
    `**Items offered:** ${entry.items_offered} from feeds: ${entry.feed_ids.join(", ")}`,
    "",
  ].join("\n");
}

export function compactDigestSummaries(archive: DigestArchiveEntry[], charBudget: number): string[] {
  // Start with all entries full. If over budget, compact oldest entries
  // one at a time until we fit or all are compacted.
  const full = archive.map(formatDigestFull);
  const totalChars = full.reduce((sum, s) => sum + s.length, 0);

  if (totalChars <= charBudget) {
    return full;
  }

  // Compact from oldest to newest until within budget
  const result = [...full];
  let currentTotal = totalChars;
  for (let i = 0; i < archive.length && currentTotal > charBudget; i++) {
    const compact = formatDigestCompact(archive[i]);
    currentTotal -= result[i].length;
    currentTotal += compact.length;
    result[i] = compact;
  }

  return result;
}

// Reserve ~2000 chars for the synthesis prompt scaffolding (instructions,
// section headers, etc.) beyond interests/lens content.
const SYNTHESIS_SCAFFOLDING_CHARS = 2000;

// Fallback character budget when no max_input_tokens is provided.
const DEFAULT_SYNTHESIS_DIGESTS_CHARS = 120_000;

// ── Prompt building ──────────────────────────────────────────────

export function buildWeeklySynthesisPrompt(
  archive: DigestArchiveEntry[],
  interests?: string,
  lens?: string,
  maxInputTokens?: number,
): string {
  const interestsSection = buildInterestsSection(interests ?? "");
  const lensSection = buildLensSection(lens ?? "");

  // Derive the digest section char budget from the configured max_input_tokens.
  // The ~4 chars/token heuristic matches estimatePromptTokens in agent.ts.
  // Reserve space for interests, lens, and scaffolding so the full prompt fits.
  let digestCharBudget = DEFAULT_SYNTHESIS_DIGESTS_CHARS;
  if (maxInputTokens) {
    const totalCharBudget = maxInputTokens * 4;
    const overhead = interestsSection.length + lensSection.length + SYNTHESIS_SCAFFOLDING_CHARS;
    digestCharBudget = Math.max(totalCharBudget - overhead, 1000);
  }

  // Build per-digest summaries for the LLM to analyze.
  // To prevent oversized prompts, we include full digest text for recent
  // entries but compact older entries to just their metadata/summary when
  // the total would exceed the character budget.
  const digestSummaries = compactDigestSummaries(archive, digestCharBudget);

  return [
    "# Weekly Synthesis",
    "",
    `You are reviewing your last **${archive.length} digests** to produce a weekly meta-analysis.`,
    "Your reply will be posted DIRECTLY to the Discord channel as-is. Every word you write will be seen by the audience.",
    "Do NOT include any preamble, thinking out loud, or meta-commentary. Open with a persona-appropriate intro, then go straight into the analysis.",
    "",
    ...(lensSection ? [lensSection] : []),
    ...(interestsSection ? [interestsSection] : []),
    "## Your task",
    "Write a weekly synthesis that covers these five areas:",
    "",
    "### 1. Trend Detection",
    "Identify themes that kept recurring across your digests this week. Which are rising in prominence? Which are fading? Are there any new themes that emerged?",
    "",
    "### 2. Narrative Arcs",
    "Track developing stories over time. What stories evolved across multiple digests? Where are they headed? What's the trajectory?",
    "",
    "### 3. Prediction Scorecard",
    "Review any predictions, expectations, or forward-looking statements you made in earlier digests. Did they pan out? Score yourself honestly.",
    "",
    "### 4. Interest Drift",
    "Which of your interest areas saw the most activity this week? Which were underserved? Are there emerging topics that deserve more attention?",
    "",
    "### 5. Source Quality",
    "Which feeds consistently produced items you engaged with deeply? Which feeds are underperforming or redundant?",
    "",
    "## Style",
    "- This is a reflective, analytical piece — not a news digest. Step back and see the bigger picture.",
    "- Be opinionated. Flag what surprised you, what you got wrong, and what you'd watch next week.",
    "- Use section headers for the five areas above.",
    "- Include specific references to items/stories from your digests as evidence.",
    "",
    "## Your digests from this period",
    "",
    ...digestSummaries,
  ].join("\n");
}

// ── Execution ────────────────────────────────────────────────────

export function isSynthesisTime(
  synthesisDay: number,
  synthesisTime: string,
  getCurrentTime?: () => { dayOfWeek: number; hour: number; minute: number },
): boolean {
  const getTime = getCurrentTime ?? (() => {
    const now = new Date();
    const pacificDate = new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      hour: "numeric",
      minute: "numeric",
      hour12: false,
      timeZone: PACIFIC_TIME_ZONE,
    }).formatToParts(now);

    const dayStr = pacificDate.find(p => p.type === "weekday")?.value ?? "";
    const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const dayOfWeek = dayMap[dayStr] ?? -1;
    const hour = Number(pacificDate.find(p => p.type === "hour")?.value ?? "0");
    const minute = Number(pacificDate.find(p => p.type === "minute")?.value ?? "0");
    return { dayOfWeek, hour, minute };
  });

  const { dayOfWeek, hour, minute } = getTime();
  if (dayOfWeek !== synthesisDay) return false;

  const currentTimeStr = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  return currentTimeStr === synthesisTime;
}

export async function runWeeklySynthesis(options: {
  feedsConfig: FeedsConfig;
  jobQueue: JobQueue;
  agent: SynthesisAgent;
  bot: SynthesisBot;
  digestModel?: string;
  log?: SynthesisLogger;
  archivePath?: string;
  interestsPath?: string;
  lensPath?: string;
  maxInputTokens?: number;
  onSynthesis?: (response: { content: string; usage: Usage }) => void;
  onSynthesisMetrics?: (metrics: SynthesisMetrics) => void;
}): Promise<void> {
  const log = options.log ?? console;
  const archivePath = options.archivePath;

  if (!archivePath) {
    log.log("[synthesis] No archive path configured — skipping");
    return;
  }

  const archive = loadDigestArchive(archivePath);
  if (archive.length === 0) {
    log.log("[synthesis] No archived digests — skipping weekly synthesis");
    return;
  }

  // Use digests from the last 7 days
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const recentArchive = archive.filter((e) => e.timestamp >= cutoff);

  if (recentArchive.length < 3) {
    log.log(`[synthesis] Only ${recentArchive.length} digests in the last 7 days — skipping (need at least 3)`);
    return;
  }

  const interests = options.interestsPath ? loadInterests(options.interestsPath) : "";
  const lens = options.lensPath ? loadLens(options.lensPath) : "";
  const prompt = buildWeeklySynthesisPrompt(recentArchive, interests, lens, options.maxInputTokens);
  const digestModel = options.digestModel;

  log.log(`[synthesis] Running weekly synthesis over ${recentArchive.length} digests`);

  const accepted = await options.jobQueue.enqueue(async () => {
    const statsBefore = options.agent.getBudgetStats?.();
    options.agent.clearWindow();

    let response: { content: string; usage: Usage };
    try {
      response = await options.agent.chat(prompt, options.feedsConfig.channel_id, {
        maxTurns: options.feedsConfig.digest_max_turns ?? 10,
        model: digestModel,
      });
    } catch (error) {
      log.error("[synthesis] agent.chat failed during weekly synthesis:", error);
      return;
    }

    const statsAfter = options.agent.getBudgetStats?.();
    if (statsBefore && statsAfter) {
      const firstTimestamp = recentArchive[0].timestamp.slice(0, 10);
      const lastTimestamp = recentArchive[recentArchive.length - 1].timestamp.slice(0, 10);
      const periodDays = Math.ceil(
        (new Date(lastTimestamp).getTime() - new Date(firstTimestamp).getTime()) / (24 * 60 * 60 * 1000),
      ) + 1;

      const metrics: SynthesisMetrics = {
        digests_analyzed: recentArchive.length,
        period_days: periodDays,
        input_tokens: response.usage.inputTokens,
        output_tokens: response.usage.outputTokens,
        cost_cents: statsAfter.costCents - statsBefore.costCents,
        response_length: response.content.length,
        model: digestModel,
      };
      log.log(`[synthesis] Weekly synthesis complete: ${metrics.digests_analyzed} digests over ${metrics.period_days} days, $${(metrics.cost_cents / 100).toFixed(4)}`);
      options.onSynthesisMetrics?.(metrics);
    }

    options.onSynthesis?.(response);

    try {
      await options.bot.sendToChannel(options.feedsConfig.channel_id, `📊 **Weekly Synthesis**\n\n${response.content}`);
    } catch (error) {
      log.error("[synthesis] Failed to send weekly synthesis to Discord:", error);
    }
  }, "feed");

  if (!accepted) {
    log.log("[synthesis] Weekly synthesis deferred — job queue busy");
  }
}
