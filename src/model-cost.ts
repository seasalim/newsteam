/**
 * Single source of truth for model cost rates and dollar formatting.
 * All cost estimation (BudgetTracker, config validation) goes through
 * estimateCostCents / resolveModelCostRate.
 */

export interface ModelCostRate {
  inputPer1M: number;
  outputPer1M: number;
}

// Rates in cents per 1M tokens. Keys are provider-prefixed base model
// names; versioned variants (e.g. "-preview", date suffixes) resolve
// via longest-prefix match in resolveModelCostRate.
const MODEL_COST_RATES: Record<string, ModelCostRate> = {
  "anthropic/claude-haiku-4-5": { inputPer1M: 25, outputPer1M: 125 },
  "anthropic/claude-sonnet-4-6": { inputPer1M: 300, outputPer1M: 1500 },
  "google/gemini-3-flash": { inputPer1M: 50, outputPer1M: 300 },
  "google/gemini-3.1-pro": { inputPer1M: 200, outputPer1M: 1200 },
  "openai/gpt-5.4-mini": { inputPer1M: 75, outputPer1M: 450 },
  "openai/gpt-5.4": { inputPer1M: 250, outputPer1M: 1500 },
  "openai/gpt-5.5": { inputPer1M: 500, outputPer1M: 3000 },
  "openai/gpt-5.6-luna": { inputPer1M: 100, outputPer1M: 600 },
  "openai/gpt-5.6-terra": { inputPer1M: 250, outputPer1M: 1500 },
  "openai/gpt-5.6-sol": { inputPer1M: 500, outputPer1M: 3000 },
  "openai/gpt-5.6": { inputPer1M: 500, outputPer1M: 3000 },
};

const DEFAULT_COST_RATE: ModelCostRate = { inputPer1M: 25, outputPer1M: 125 };

// Keys sorted longest-first so the most specific prefix wins.
const RATE_KEYS_BY_LENGTH = Object.keys(MODEL_COST_RATES).sort(
  (left, right) => right.length - left.length,
);

// Characters that may follow a base model name in a versioned variant.
const VARIANT_BOUNDARY_CHARS = new Set(["-", ".", "@", ":"]);

/** Resolve a model name to its cost rate, or null if unknown. */
export function resolveModelCostRate(model: string): ModelCostRate | null {
  const exact = MODEL_COST_RATES[model];
  if (exact) {
    return exact;
  }

  for (const key of RATE_KEYS_BY_LENGTH) {
    if (model.startsWith(key) && VARIANT_BOUNDARY_CHARS.has(model[key.length]!)) {
      return MODEL_COST_RATES[key]!;
    }
  }

  return null;
}

export function isKnownCostModel(model: string): boolean {
  return resolveModelCostRate(model) !== null;
}

const warnedUnknownModels = new Set<string>();

/**
 * Estimate the cost in cents for a call. Unknown models fall back to the
 * default rate but warn (once per model) — a stale rate table should be
 * loud, never silent.
 */
export function estimateCostCents(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  let rate = resolveModelCostRate(model);

  if (!rate) {
    if (!warnedUnknownModels.has(model)) {
      warnedUnknownModels.add(model);
      console.warn(
        `[cost] WARNING: No cost rate for model "${model}" — using default rate ` +
        `(${DEFAULT_COST_RATE.inputPer1M}/${DEFAULT_COST_RATE.outputPer1M} cents per 1M). ` +
        `Add it to MODEL_COST_RATES in src/model-cost.ts for accurate budgets.`,
      );
    }
    rate = DEFAULT_COST_RATE;
  }

  return (
    (inputTokens / 1_000_000) * rate.inputPer1M +
    (outputTokens / 1_000_000) * rate.outputPer1M
  );
}

export function formatDollarsFromCents(costCents: number): string {
  return (costCents / 100).toFixed(3);
}
