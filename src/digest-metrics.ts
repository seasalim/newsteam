export type DigestQualityMetrics = {
  items_offered: number;
  items_fetched: number;
  large_digest_zero_fetch?: boolean;
  tool_calls: number;
  feed_ids: string[];
  fetched_item_urls?: string[];
};

export interface DigestQualityEvaluation {
  timestamp: string;
  scores: {
    relevance: number;
    depth: number;
    originality: number;
    connections: number;
    tool_efficiency: number;
  };
  summary: string;
  input_tokens: number;
  output_tokens: number;
  cost_cents: number;
  model: string;
  attempt_count?: number;
  used_repair?: boolean;
  used_strict_retry?: boolean;
  validation_error?: string | null;
  suspicious_reasons?: string[];
  confidence?: "high" | "low";
}
