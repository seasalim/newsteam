export type ThinkingLevel = "minimal" | "low" | "medium" | "high";

export type ProviderMetadata = Record<string, unknown> | undefined;

export interface TextBlock {
  type: "text";
  text: string;
  providerMetadata?: ProviderMetadata;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
  providerMetadata?: ProviderMetadata;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export interface ChatMessage {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

export interface ToolSchema {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ChatRequest {
  model: string;
  system: string;
  messages: ChatMessage[];
  maxTokens: number;
  tools?: ToolSchema[];
  temperature?: number;
  responseSchema?: Record<string, unknown>;
  thinkingLevel?: ThinkingLevel;
}

export interface ChatResponse {
  content: ContentBlock[];
  usage: {
    inputTokens: number;
    outputTokens: number;
    thinkingTokens?: number;
    billedOutputTokens?: number;
  };
  stopReason: "end_turn" | "max_tokens" | "tool_use";
  providerMetadata?: ProviderMetadata;
}

export interface LLMClient {
  chat(request: ChatRequest): Promise<ChatResponse>;
}
