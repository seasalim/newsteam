/**
 * Digest quality evaluation and context extraction.
 *
 * Extracted from agent.ts to keep files under 500 lines.
 * These are stateless functions that receive their dependencies.
 */

import type { DigestQualityEvaluation } from "./agent.ts";
import type { BudgetTracker } from "./budget.ts";
import type { DigestQualityMetrics } from "./digest-metrics.ts";
import type { LLMClient, ThinkingLevel } from "./llm-types.ts";
import type { EventLogger } from "./logger.ts";
import {
  extractTextContent,
  parseJsonObject,
  validateStructuredValue,
  withResponseText,
  type StructuredJsonError,
  type StructuredJsonResult,
} from "./structured-json.ts";

interface EvalDeps {
  llmClient: LLMClient;
  budget: BudgetTracker;
  model: string;
  modelLabel: string;
  thinkingLevel?: ThinkingLevel;
  logger?: EventLogger;
  logData: (data: Record<string, unknown>) => Record<string, unknown>;
}

const DIGEST_QUALITY_SCHEMA = {
  type: "object",
  properties: {
    scores: {
      type: "object",
      properties: {
        relevance: { type: "number", minimum: 1, maximum: 5 },
        depth: { type: "number", minimum: 1, maximum: 5 },
        originality: { type: "number", minimum: 1, maximum: 5 },
        connections: { type: "number", minimum: 1, maximum: 5 },
        tool_efficiency: { type: "number", minimum: 1, maximum: 5 },
      },
      required: ["relevance", "depth", "originality", "connections", "tool_efficiency"],
      additionalProperties: false,
    },
    summary: { type: "string", minLength: 1 },
  },
  required: ["scores", "summary"],
  additionalProperties: false,
} as const satisfies Record<string, unknown>;

const DIGEST_CONTEXT_SCHEMA = {
  type: "object",
  properties: {
    topics: {
      type: "array",
      items: { type: "string" },
      maxItems: 4,
    },
    entities: {
      type: "array",
      items: { type: "string" },
      maxItems: 6,
    },
    sentiment: { type: "string" },
    summary: { type: "string" },
    interests_served: {
      type: "array",
      items: { type: "string" },
      maxItems: 3,
    },
  },
  required: ["topics", "entities", "sentiment", "summary", "interests_served"],
  additionalProperties: false,
} as const satisfies Record<string, unknown>;

async function requestStructuredJson(
  deps: EvalDeps,
  params: {
    maxTokens: number;
    system: string;
    prompt: string;
    responseSchema: Record<string, unknown>;
  },
): Promise<StructuredJsonResult> {
  let lastError: unknown;
  let invalidResponseText = "";
  let lastValidationError: string | null = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const isStrictRetryAttempt = attempt === 1;
    const system = isStrictRetryAttempt
      ? `${params.system} CRITICAL: Start over and return exactly one compact valid JSON object. Keep arrays short and string values concise. No prose, no markdown, no code fences.`
      : params.system;
    const prompt = isStrictRetryAttempt
      ? `${params.prompt}\n\nPrevious output was invalid. Start over from the source text and return one compact JSON object only. Keep arrays short and summaries brief. Your response must parse successfully with JSON.parse().`
      : params.prompt;

    const response = await deps.llmClient.chat({
      model: deps.model,
      maxTokens: params.maxTokens,
      system,
      temperature: 0,
      responseSchema: params.responseSchema,
      thinkingLevel: deps.thinkingLevel,
      messages: [{ role: "user", content: prompt }],
    });

    deps.budget.record(
      response.usage.inputTokens,
      response.usage.billedOutputTokens ?? response.usage.outputTokens,
      undefined,
      deps.modelLabel,
    );
    invalidResponseText = extractTextContent(response);

    try {
      const parsed = parseJsonObject(invalidResponseText);
      const validationError = validateStructuredValue(parsed, params.responseSchema);
      if (validationError) {
        throw new Error(validationError);
      }

      return {
        parsed,
        responseText: invalidResponseText,
        attemptCount: attempt + 1,
        usedRepair: false,
        usedStrictRetry: isStrictRetryAttempt,
        validationError: lastValidationError,
      };
    } catch (error) {
      lastValidationError = error instanceof Error ? error.message : String(error);
      lastError = withResponseText(error, invalidResponseText);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function collectSuspiciousDigestQualityReasons(
  scores: DigestQualityEvaluation["scores"],
  summary: string,
  outputTokens: number,
): string[] {
  const reasons: string[] = [];
  const normalizedSummary = summary.trim().toLowerCase();

  if (normalizedSummary.length === 0) {
    reasons.push("empty_summary");
  }

  if (normalizedSummary === "repaired summary"
    || normalizedSummary === "repaired json summary"
    || normalizedSummary === "valid summary") {
    reasons.push("placeholder_summary");
  }

  if (normalizedSummary === "good digest overall."
    || normalizedSummary === "good digest overall"
    || normalizedSummary === "solid selection."
    || normalizedSummary === "solid selection") {
    reasons.push("generic_summary");
  }

  const scoreValues = Object.values(scores);
  if (scoreValues.every((value) => value === 1)) {
    reasons.push("all_scores_one");
  } else if (scoreValues.every((value) => value === 3)) {
    reasons.push("all_scores_three");
  } else if (scoreValues.every((value) => value === scoreValues[0])) {
    reasons.push("all_scores_equal");
  }

  if (outputTokens > 140) {
    reasons.push("output_tokens_high");
  }

  return reasons;
}

export async function evaluateDigestQuality(
  deps: EvalDeps,
  input: {
    digestText: string;
    items: Array<{ feed_name?: string; title?: string; url?: string; snippet?: string | null }>;
    metrics: DigestQualityMetrics;
  },
): Promise<DigestQualityEvaluation | null> {
  const evaluationPrompt = [
    "Evaluate the quality of this feed digest. Return ONLY valid JSON with no markdown formatting, no code fences, and no extra text.",
    "",
    "Required JSON format:",
    '{"scores":{"relevance":4,"depth":3,"originality":3,"connections":2,"tool_efficiency":4},"summary":"One short sentence."}',
    "",
    "Rules:",
    "- Score each dimension from 1 to 5.",
    "- relevance: Did the digest focus on the most worthwhile items?",
    "- depth: Did it go beyond shallow summary on the key items?",
    "- originality: Did it add non-obvious analysis?",
    "- connections: Did it connect related items or broader patterns?",
    "- tool_efficiency: Were fetches targeted at the most important items? Fetching 2-5 of 10-15 items is ideal — penalize only if zero fetches were made on a large digest or if fetches were wasted on low-value items.",
    "- Accuracy and grounding are mandatory across all scores. Penalize any unsupported specific detail, causal attribution, quote, or confidence level that is not clearly supported by the offered snippets.",
    "- If the digest turns correlation or timing into causation, penalize it.",
    "- If the digest makes a strong claim about an item whose URL is NOT in fetched_item_urls, assume the writer only had the title/snippet and penalize unsupported certainty accordingly.",
    "- Penalize cross-article splicing: do not reward a digest that borrows a codename, assassination method, motive, or other concrete detail from one source and attaches it to a different story without explicit support.",
    "- Penalize sections where multiple links are cited but the concrete factual claim is not clearly supported by any of those same links.",
    "- summary: one short sentence on the main strength or weakness.",
    "",
    "Offered items:",
    JSON.stringify(input.items.map((item) => ({
      feed_name: item.feed_name ?? "",
      title: item.title ?? "",
      url: item.url ?? "",
      snippet: typeof item.snippet === "string" ? item.snippet.slice(0, 400) : "",
    })), null, 2),
    "",
    "Digest metrics:",
    JSON.stringify(input.metrics, null, 2),
    "",
    "Digest text:",
    input.digestText,
  ].join("\n");

  try {
    const statsBefore = deps.budget.getStats();
    const {
      parsed,
      responseText,
      attemptCount,
      usedRepair,
      usedStrictRetry,
      validationError,
    } = await requestStructuredJson(deps, {
      maxTokens: 150,
      system: "You evaluate feed digests. Return only valid JSON.",
      prompt: evaluationPrompt,
      responseSchema: DIGEST_QUALITY_SCHEMA,
    });
    const typedParsed = parsed as {
      scores?: Record<string, unknown>;
      summary?: unknown;
    };
    const statsAfter = deps.budget.getStats();
    const scores = typedParsed.scores ?? {};
    const clampScore = (value: unknown): number => {
      const num = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(num)) return 3;
      return Math.max(1, Math.min(5, Math.round(num)));
    };
    const evaluation: DigestQualityEvaluation = {
      timestamp: new Date().toISOString(),
      scores: {
        relevance: clampScore(scores.relevance),
        depth: clampScore(scores.depth),
        originality: clampScore(scores.originality),
        connections: clampScore(scores.connections),
        tool_efficiency: clampScore(scores.tool_efficiency),
      },
      summary: typeof typedParsed.summary === "string" ? typedParsed.summary : "",
      input_tokens: statsAfter.inputTokens - statsBefore.inputTokens,
      output_tokens: statsAfter.outputTokens - statsBefore.outputTokens,
      cost_cents: statsAfter.costCents - statsBefore.costCents,
      model: deps.modelLabel,
      attempt_count: attemptCount,
      used_repair: usedRepair,
      used_strict_retry: usedStrictRetry,
      validation_error: validationError,
    };
    const suspiciousReasons = collectSuspiciousDigestQualityReasons(
      evaluation.scores,
      evaluation.summary,
      evaluation.output_tokens,
    );
    evaluation.suspicious_reasons = suspiciousReasons;
    evaluation.confidence = usedRepair || usedStrictRetry || suspiciousReasons.length > 0
      ? "low"
      : "high";

    if (suspiciousReasons.length > 0) {
      deps.logger?.emit("agent.digest_quality.suspicious", deps.logData({
        reasons: suspiciousReasons,
        scores: evaluation.scores,
        summary: evaluation.summary,
        output_tokens: evaluation.output_tokens,
        response_text: responseText,
      }));
    }

    return evaluation;
  } catch (err) {
    const structuredError = err instanceof Error ? err as StructuredJsonError : undefined;
    deps.logger?.emit("agent.digest_quality.failed", deps.logData({
      error: err instanceof Error ? err.message : String(err),
      ...(structuredError?.responseText ? { response_text: structuredError.responseText } : {}),
    }));
    return null;
  }
}

export async function extractDigestContext(
  deps: EvalDeps,
  digestText: string,
): Promise<{ timestamp: string; topics: string[]; entities: string[]; sentiment: string; summary: string; interests_served: string[] } | null> {
  const extractionPrompt = [
    "Extract key metadata from this feed digest that was just posted. Return ONLY valid JSON with no markdown formatting, no code fences, no extra text.",
    "",
    "Required JSON format:",
    '{"topics":["topic1","topic2"],"entities":["entity1","entity2"],"sentiment":"one-word overall mood","summary":"1-2 sentence summary of what was covered","interests_served":["interest1","interest2"]}',
    "",
    "Rules:",
    "- topics: 2-4 short key themes or subject areas discussed",
    "- entities: up to 6 notable people, companies, projects, or products mentioned",
    "- sentiment: single word (bullish, bearish, neutral, excited, cautious, mixed, etc.)",
    "- summary: one short sentence focusing on the most important items covered",
    "- interests_served: up to 3 broad interest areas this digest addressed (e.g. 'AI/ML', 'crypto', 'geopolitics'). Empty array if unclear.",
    "- Keep the JSON compact. Do not repeat the digest verbatim.",
    "",
    "Digest text:",
    digestText,
  ].join("\n");

  try {
    const { parsed } = await requestStructuredJson(deps, {
      maxTokens: 600,
      system: "You extract structured metadata from text. Return only valid JSON.",
      prompt: extractionPrompt,
      responseSchema: DIGEST_CONTEXT_SCHEMA,
    });
    return {
      timestamp: new Date().toISOString(),
      topics: Array.isArray(parsed.topics) ? parsed.topics.map(String) : [],
      entities: Array.isArray(parsed.entities) ? parsed.entities.map(String) : [],
      sentiment: typeof parsed.sentiment === "string" ? parsed.sentiment : "neutral",
      summary: typeof parsed.summary === "string" ? parsed.summary : "",
      interests_served: Array.isArray(parsed.interests_served) ? parsed.interests_served.map(String) : [],
    };
  } catch (err) {
    const structuredError = err instanceof Error ? err as StructuredJsonError : undefined;
    deps.logger?.emit("agent.context.extraction_failed", deps.logData({
      error: err instanceof Error ? err.message : String(err),
      ...(structuredError?.responseText ? { response_text: structuredError.responseText } : {}),
    }));
    return null;
  }
}
