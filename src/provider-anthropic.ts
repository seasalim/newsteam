import Anthropic from "@anthropic-ai/sdk";

import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ContentBlock,
  LLMClient,
  ToolSchema,
} from "./llm-types.ts";
import { stripProviderPrefix } from "./model.ts";

type AnthropicClientLike = Pick<Anthropic, "messages">;

function toAnthropicBlock(block: ContentBlock): Anthropic.ContentBlockParam {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "tool_use":
      return {
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: block.input,
      };
    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: block.tool_use_id,
        content: block.content,
        is_error: block.is_error,
      };
  }
}

function toAnthropicMessage(message: ChatMessage): Anthropic.MessageParam {
  return {
    role: message.role,
    content: typeof message.content === "string"
      ? message.content
      : message.content.map((block) => toAnthropicBlock(block)),
  };
}

function toAnthropicTools(
  tools: ToolSchema[] | undefined,
): Anthropic.MessageCreateParamsNonStreaming["tools"] | undefined {
  if (!tools || tools.length === 0) {
    return undefined;
  }

  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.input_schema as Anthropic.Tool.InputSchema,
  } as Anthropic.Tool));
}

function toContentBlocks(blocks: Anthropic.Message["content"]): ContentBlock[] {
  return blocks.flatMap((block): ContentBlock[] => {
    switch (block.type) {
      case "text":
        return [{ type: "text", text: block.text }];
      case "tool_use":
        return [{
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: (isRecord(block.input) ? block.input : {}) as Record<string, unknown>,
        }];
      default:
        return [];
    }
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toChatResponse(response: Anthropic.Message): ChatResponse {
  return {
    content: toContentBlocks(response.content),
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      billedOutputTokens: response.usage.output_tokens,
    },
    stopReason: response.stop_reason === "max_tokens"
      ? "max_tokens"
      : response.stop_reason === "tool_use"
        ? "tool_use"
        : "end_turn",
  };
}

export function createAnthropicClient(
  apiKey: string,
  model: string,
  anthropicClient?: AnthropicClientLike,
): LLMClient {
  const client = anthropicClient ?? new Anthropic({ apiKey });
  const defaultModel = stripProviderPrefix(model);

  return {
    async chat(request: ChatRequest): Promise<ChatResponse> {
      const response = await client.messages.create({
        model: request.model || defaultModel,
        max_tokens: request.maxTokens,
        system: request.system,
        messages: request.messages.map((message) => toAnthropicMessage(message)),
        tools: toAnthropicTools(request.tools),
        temperature: request.temperature,
      });

      return toChatResponse(response);
    },
  };
}
