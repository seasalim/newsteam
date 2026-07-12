import OpenAI from "openai";
import type {
  FunctionTool,
  Response,
  ResponseCreateParamsNonStreaming,
  ResponseInput,
  ResponseInputItem,
  ResponseReasoningItem,
} from "openai/resources/responses/responses";

import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ContentBlock,
  LLMClient,
  ProviderMetadata,
  ToolSchema,
} from "./llm-types.ts";
import { stripProviderPrefix } from "./model.ts";

type OpenAIClientLike = Pick<OpenAI, "responses">;

interface OpenAIBlockMetadata extends Record<string, unknown> {
  openaiReasoningItems?: ResponseReasoningItem[];
  openaiItemId?: string;
  rawArguments?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getOpenAIMetadata(block: ContentBlock): OpenAIBlockMetadata | undefined {
  if (block.type === "tool_result" || !isRecord(block.providerMetadata)) {
    return undefined;
  }

  const reasoningItems = Array.isArray(block.providerMetadata.openaiReasoningItems)
    ? block.providerMetadata.openaiReasoningItems as ResponseReasoningItem[]
    : undefined;

  return {
    openaiReasoningItems: reasoningItems,
    openaiItemId: typeof block.providerMetadata.openaiItemId === "string"
      ? block.providerMetadata.openaiItemId
      : undefined,
    rawArguments: typeof block.providerMetadata.rawArguments === "string"
      ? block.providerMetadata.rawArguments
      : undefined,
  };
}

function appendTextMessage(
  input: ResponseInput,
  role: ChatMessage["role"],
  text: string,
): void {
  if (text.length > 0) {
    input.push({ role, content: text });
  }
}

function toOpenAIInput(messages: ChatMessage[]): ResponseInput {
  const input: ResponseInput = [];

  for (const message of messages) {
    if (typeof message.content === "string") {
      appendTextMessage(input, message.role, message.content);
      continue;
    }

    let pendingText: string[] = [];
    const flushText = (): void => {
      appendTextMessage(input, message.role, pendingText.join("\n"));
      pendingText = [];
    };

    for (const block of message.content) {
      if (block.type === "text") {
        pendingText.push(block.text);
        continue;
      }

      flushText();

      if (block.type === "tool_use") {
        const metadata = getOpenAIMetadata(block);
        // Stateless reasoning models require their encrypted reasoning item before
        // the corresponding function call on the next request.
        for (const reasoningItem of metadata?.openaiReasoningItems ?? []) {
          input.push(reasoningItem);
        }
        input.push({
          type: "function_call",
          call_id: block.id,
          name: block.name,
          arguments: metadata?.rawArguments ?? JSON.stringify(block.input),
          ...(metadata?.openaiItemId ? { id: metadata.openaiItemId } : {}),
        });
      } else {
        input.push({
          type: "function_call_output",
          call_id: block.tool_use_id,
          output: block.content,
        });
      }
    }

    flushText();
  }

  return input;
}

function toOpenAITools(tools: ToolSchema[] | undefined): FunctionTool[] | undefined {
  if (!tools || tools.length === 0) {
    return undefined;
  }

  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.input_schema,
    strict: false,
  }));
}

function toOpenAIReasoningEffort(
  thinkingLevel: ChatRequest["thinkingLevel"],
): "low" | "medium" | "high" | undefined {
  if (!thinkingLevel) {
    return undefined;
  }

  return thinkingLevel === "minimal" ? "low" : thinkingLevel;
}

function supportsTemperature(model: string): boolean {
  // Current GPT-5 and o-series reasoning modes reject sampling controls.
  return !/^(?:gpt-5(?:[.-]|$)|o\d+(?:[.-]|$))/u.test(model);
}

function parseToolArguments(argumentsJson: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(argumentsJson);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function toContentBlocks(response: Response): ContentBlock[] {
  const content: ContentBlock[] = [];
  let pendingReasoningItems: ResponseReasoningItem[] = [];

  for (const item of response.output) {
    if (item.type === "reasoning") {
      pendingReasoningItems.push(item);
      continue;
    }

    if (item.type === "message") {
      for (const part of item.content) {
        content.push({
          type: "text",
          text: part.type === "output_text" ? part.text : part.refusal,
          providerMetadata: { openaiItemId: item.id },
        });
      }
      continue;
    }

    if (item.type === "function_call") {
      const metadata: OpenAIBlockMetadata = {
        openaiItemId: item.id,
        rawArguments: item.arguments,
        ...(pendingReasoningItems.length > 0
          ? { openaiReasoningItems: pendingReasoningItems }
          : {}),
      };
      pendingReasoningItems = [];
      content.push({
        type: "tool_use",
        id: item.call_id,
        name: item.name,
        input: parseToolArguments(item.arguments),
        providerMetadata: metadata,
      });
    }
  }

  if (content.length === 0 && response.output_text.length > 0) {
    content.push({ type: "text", text: response.output_text });
  }

  return content;
}

function toUsage(response: Response): ChatResponse["usage"] {
  const billedOutputTokens = response.usage?.output_tokens ?? 0;
  const thinkingTokens = response.usage?.output_tokens_details.reasoning_tokens ?? 0;

  return {
    inputTokens: response.usage?.input_tokens ?? 0,
    outputTokens: Math.max(0, billedOutputTokens - thinkingTokens),
    thinkingTokens,
    billedOutputTokens,
  };
}

function toResponseMetadata(response: Response): ProviderMetadata {
  return {
    responseId: response.id,
    status: response.status,
    ...(response.incomplete_details?.reason
      ? { incompleteReason: response.incomplete_details.reason }
      : {}),
    outputItemCount: response.output.length,
  };
}

function toStopReason(response: Response, content: ContentBlock[]): ChatResponse["stopReason"] {
  if (content.some((block) => block.type === "tool_use")) {
    return "tool_use";
  }

  return response.status === "incomplete" &&
      response.incomplete_details?.reason === "max_output_tokens"
    ? "max_tokens"
    : "end_turn";
}

export function createOpenAIClient(
  apiKey: string,
  model: string,
  openAIClient?: OpenAIClientLike,
): LLMClient {
  const client = openAIClient ?? new OpenAI({ apiKey });
  const defaultModel = stripProviderPrefix(model);

  return {
    async chat(request: ChatRequest): Promise<ChatResponse> {
      const effectiveModel = request.model || defaultModel;
      const params: ResponseCreateParamsNonStreaming = {
        model: effectiveModel,
        instructions: request.system,
        input: toOpenAIInput(request.messages),
        max_output_tokens: request.maxTokens,
        tools: toOpenAITools(request.tools),
        ...(request.temperature !== undefined && supportsTemperature(effectiveModel)
          ? { temperature: request.temperature }
          : {}),
        reasoning: request.thinkingLevel
          ? { effort: toOpenAIReasoningEffort(request.thinkingLevel) }
          : undefined,
        text: request.responseSchema
          ? {
            format: {
              type: "json_schema",
              name: "newsteam_response",
              schema: request.responseSchema,
              strict: false,
            },
          }
          : undefined,
        include: ["reasoning.encrypted_content"],
        store: false,
      };
      const response = await client.responses.create(params);
      const content = toContentBlocks(response);

      return {
        content,
        usage: toUsage(response),
        stopReason: toStopReason(response, content),
        providerMetadata: toResponseMetadata(response),
      };
    },
  };
}
