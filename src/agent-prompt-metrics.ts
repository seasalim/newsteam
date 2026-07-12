import { estimatePromptTokens } from "./agent-context.ts";
import type {
  ChatMessage,
  ChatResponse,
  ThinkingLevel,
  ToolResultBlock,
  ToolSchema,
} from "./llm-types.ts";
import type { EventLogger } from "./logger.ts";

export interface PromptMessageSummary {
  userMessages: number;
  assistantMessages: number;
  textChars: number;
  toolUseBlocks: number;
  toolResultBlocks: number;
  toolResultChars: number;
}

function estimateToolResultChars(block: ToolResultBlock): number {
  return typeof block.content === "string" ? block.content.length : 0;
}

export function estimateToolSchemaTokens(toolSchemas: ToolSchema[] | undefined): number {
  if (!toolSchemas || toolSchemas.length === 0) {
    return 0;
  }

  const totalChars = toolSchemas.reduce(
    (sum, tool) => sum + tool.name.length + tool.description.length + JSON.stringify(tool.input_schema).length,
    0,
  );

  return Math.ceil(totalChars / 4);
}

export interface PromptMetricsInput {
  requestKind: "main" | "final_retry";
  logicalTurn: number;
  requestIndex: number;
  isFinalAllowedTurn: boolean;
  systemPrompt: string;
  messagesBeforeTrim: number;
  estimatedPromptTokensBeforeTrim: number;
  requestMessages: ChatMessage[];
  activeToolSchemas?: ToolSchema[];
  toolsEnabled: boolean;
  response: ChatResponse;
}

export function createPromptMetricsEmitter(options: {
  logger?: EventLogger;
  logData: (data: Record<string, unknown>) => Record<string, unknown>;
  model: string;
  thinkingLevel?: ThinkingLevel;
  maxInputTokens: number;
}): (input: PromptMetricsInput) => void {
  return (input) => {
    const estimatedPromptTokensAfterTrim = estimatePromptTokens(input.systemPrompt, input.requestMessages);
    const promptSummary = summarizePromptMessages(input.requestMessages);
    const estimatedToolSchemaCount = input.activeToolSchemas?.length ?? 0;
    const estimatedToolSchemaTokenCount = estimateToolSchemaTokens(input.activeToolSchemas);
    const estimatedPromptTokensAfterTrimWithTools =
      estimatedPromptTokensAfterTrim + estimatedToolSchemaTokenCount;

    options.logger?.emit("agent.prompt.metrics", options.logData({
      request_kind: input.requestKind,
      logical_turn: input.logicalTurn,
      request_index: input.requestIndex,
      is_final_allowed_turn: input.isFinalAllowedTurn,
      model: options.model,
      thinking_level: options.thinkingLevel,
      max_input_tokens: options.maxInputTokens,
      messages_before_trim: input.messagesBeforeTrim,
      messages_after_trim: input.requestMessages.length,
      trimmed_messages: Math.max(0, input.messagesBeforeTrim - input.requestMessages.length),
      estimated_prompt_tokens_before_trim: input.estimatedPromptTokensBeforeTrim,
      estimated_prompt_tokens_after_trim: estimatedPromptTokensAfterTrim,
      tool_schema_count: estimatedToolSchemaCount,
      estimated_tool_schema_tokens: estimatedToolSchemaTokenCount,
      estimated_prompt_tokens_after_trim_with_tools: estimatedPromptTokensAfterTrimWithTools,
      tools_enabled: input.toolsEnabled,
      user_messages_after_trim: promptSummary.userMessages,
      assistant_messages_after_trim: promptSummary.assistantMessages,
      text_chars_after_trim: promptSummary.textChars,
      tool_use_blocks_after_trim: promptSummary.toolUseBlocks,
      tool_result_blocks_after_trim: promptSummary.toolResultBlocks,
      tool_result_chars_after_trim: promptSummary.toolResultChars,
      actual_input_tokens: input.response.usage.inputTokens,
      actual_minus_estimated_after_trim: input.response.usage.inputTokens - estimatedPromptTokensAfterTrim,
      actual_minus_estimated_after_trim_with_tools:
        input.response.usage.inputTokens - estimatedPromptTokensAfterTrimWithTools,
      stop_reason: input.response.stopReason,
    }));
  };
}

export function summarizePromptMessages(apiMessages: ChatMessage[]): PromptMessageSummary {
  const summary: PromptMessageSummary = {
    userMessages: 0,
    assistantMessages: 0,
    textChars: 0,
    toolUseBlocks: 0,
    toolResultBlocks: 0,
    toolResultChars: 0,
  };

  for (const message of apiMessages) {
    if (message.role === "user") {
      summary.userMessages += 1;
    } else {
      summary.assistantMessages += 1;
    }

    if (typeof message.content === "string") {
      summary.textChars += message.content.length;
      continue;
    }

    for (const block of message.content) {
      if (block.type === "text") {
        summary.textChars += block.text.length;
        continue;
      }

      if (block.type === "tool_use") {
        summary.toolUseBlocks += 1;
        continue;
      }

      summary.toolResultBlocks += 1;
      summary.toolResultChars += estimateToolResultChars(block);
    }
  }

  return summary;
}
