import {
  GoogleGenAI,
  ThinkingLevel as GeminiThinkingLevel,
  type Content,
  type FunctionDeclaration,
  type GenerateContentResponse,
  type Part,
  type Tool,
} from "@google/genai";

import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ContentBlock,
  ProviderMetadata,
  ToolResultBlock,
  ToolSchema,
  LLMClient,
} from "./llm-types.ts";
import { stripProviderPrefix } from "./model.ts";

type GeminiClientLike = Pick<GoogleGenAI, "models">;
type GeminiMetadata = { thought?: boolean; thoughtSignature?: string };

function toGeminiThinkingLevel(
  thinkingLevel: ChatRequest["thinkingLevel"],
): GeminiThinkingLevel | undefined {
  switch (thinkingLevel) {
    case "minimal":
      return GeminiThinkingLevel.MINIMAL;
    case "low":
      return GeminiThinkingLevel.LOW;
    case "medium":
      return GeminiThinkingLevel.MEDIUM;
    case "high":
      return GeminiThinkingLevel.HIGH;
    default:
      return undefined;
  }
}

const SUPPORTED_JSON_SCHEMA_KEYS = new Set([
  "$anchor",
  "$defs",
  "$id",
  "$ref",
  "additionalProperties",
  "anyOf",
  "description",
  "enum",
  "format",
  "items",
  "maximum",
  "maxItems",
  "maxLength",
  "minimum",
  "minItems",
  "minLength",
  "oneOf",
  "properties",
  "propertyOrdering",
  "required",
  "title",
  "type",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeJsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeJsonSchema(item));
  }

  if (!isPlainObject(value)) {
    return value;
  }

  const sanitized: Record<string, unknown> = {};

  for (const [key, entry] of Object.entries(value)) {
    if (!SUPPORTED_JSON_SCHEMA_KEYS.has(key)) {
      continue;
    }

    if (key === "properties" || key === "$defs") {
      if (!isPlainObject(entry)) {
        continue;
      }

      sanitized[key] = Object.fromEntries(
        Object.entries(entry).map(([name, schema]) => [name, sanitizeJsonSchema(schema)]),
      );
      continue;
    }

    if (key === "items" || key === "additionalProperties") {
      sanitized[key] = typeof entry === "boolean" ? entry : sanitizeJsonSchema(entry);
      continue;
    }

    sanitized[key] = sanitizeJsonSchema(entry);
  }

  return sanitized;
}

function normalizeTextContent(content: string | ContentBlock[] | undefined): string {
  if (typeof content === "string") {
    return content;
  }

  if (!content) {
    return "";
  }

  return content.map((block) => {
    if (block.type === "text") {
      return block.text;
    }

    return JSON.stringify(block);
  }).join("\n");
}

function getGeminiMetadata(block: ContentBlock): GeminiMetadata | undefined {
  if (block.type === "tool_result") {
    return undefined;
  }

  const metadata = block.providerMetadata;
  if (!isPlainObject(metadata)) {
    return undefined;
  }

  return {
    thought: typeof metadata.thought === "boolean" ? metadata.thought : undefined,
    thoughtSignature: typeof metadata.thoughtSignature === "string"
      ? metadata.thoughtSignature
      : undefined,
  };
}

function toFunctionResponse(
  block: ToolResultBlock,
  toolName: string | undefined,
): Part {
  const normalizedContent = normalizeTextContent(block.content);
  return {
    functionResponse: {
      id: block.tool_use_id,
      name: toolName ?? "unknown_tool",
      response: block.is_error
        ? { error: normalizedContent }
        : { output: normalizedContent },
    },
  };
}

function withGeminiMetadata(
  part: Part,
  metadata: GeminiMetadata | undefined,
): Part {
  if (!metadata) {
    return part;
  }

  return {
    ...part,
    ...(metadata.thought !== undefined ? { thought: metadata.thought } : {}),
    ...(metadata.thoughtSignature !== undefined ? { thoughtSignature: metadata.thoughtSignature } : {}),
  };
}

function toGeminiPart(
  block: ContentBlock,
  toolNamesById: Map<string, string>,
): Part {
  const metadata = getGeminiMetadata(block);

  switch (block.type) {
    case "text":
      return withGeminiMetadata({ text: block.text }, metadata);
    case "tool_use":
      toolNamesById.set(block.id, block.name);
      return withGeminiMetadata({
        functionCall: {
          id: block.id,
          name: block.name,
          args: isPlainObject(block.input) ? block.input : {},
        },
      }, metadata);
    case "tool_result":
      return toFunctionResponse(block, toolNamesById.get(block.tool_use_id));
  }
}

function toGeminiContents(messages: ChatMessage[]): Content[] {
  const toolNamesById = new Map<string, string>();

  return messages.map((message) => ({
    role: message.role === "assistant" ? "model" : "user",
    parts: typeof message.content === "string"
      ? [{ text: message.content }]
      : message.content.map((block) => toGeminiPart(block, toolNamesById)),
  }));
}

function toGeminiTools(tools: ToolSchema[] | undefined): Tool[] | undefined {
  if (!tools || tools.length === 0) {
    return undefined;
  }

  const functionDeclarations: FunctionDeclaration[] = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parametersJsonSchema: sanitizeJsonSchema(tool.input_schema),
  }));

  return functionDeclarations.length === 0 ? undefined : [{ functionDeclarations }];
}

function extractGeminiMetadata(part: Part): ProviderMetadata {
  if (part.thought === undefined && part.thoughtSignature === undefined) {
    return undefined;
  }

  return {
    ...(part.thought !== undefined ? { thought: part.thought } : {}),
    ...(part.thoughtSignature !== undefined ? { thoughtSignature: part.thoughtSignature } : {}),
  };
}

function toContentBlocks(response: GenerateContentResponse): ContentBlock[] {
  const candidate = response.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];
  const content: ContentBlock[] = [];
  let syntheticToolIndex = 0;

  for (const part of parts) {
    if (part.text) {
      content.push({
        type: "text",
        text: part.text,
        providerMetadata: extractGeminiMetadata(part),
      });
    }

    if (part.functionCall) {
      syntheticToolIndex += 1;
      content.push({
        type: "tool_use",
        id: part.functionCall.id ?? `toolu_gemini_${syntheticToolIndex}`,
        name: part.functionCall.name ?? "unknown_tool",
        input: isPlainObject(part.functionCall.args) ? part.functionCall.args : {},
        providerMetadata: extractGeminiMetadata(part),
      });
    }
  }

  if (
    content.length === 0 &&
    typeof (response as { text?: unknown }).text === "string" &&
    (response as { text: string }).text.length > 0
  ) {
    content.push({
      type: "text",
      text: (response as { text: string }).text,
    });
  }

  return content;
}

function toStopReason(
  response: GenerateContentResponse,
  content: ContentBlock[],
): ChatResponse["stopReason"] {
  if (content.some((block) => block.type === "tool_use")) {
    return "tool_use";
  }

  return response.candidates?.[0]?.finishReason === "MAX_TOKENS"
    ? "max_tokens"
    : "end_turn";
}

function toUsage(
  response: GenerateContentResponse,
): ChatResponse["usage"] {
  const outputTokens = response.usageMetadata?.candidatesTokenCount ?? 0;
  const thinkingTokens = response.usageMetadata?.thoughtsTokenCount ?? 0;

  return {
    inputTokens: response.usageMetadata?.promptTokenCount ?? 0,
    outputTokens,
    thinkingTokens,
    billedOutputTokens: outputTokens + thinkingTokens,
  };
}

function toResponseMetadata(
  response: GenerateContentResponse,
  content: ContentBlock[],
): ProviderMetadata {
  const candidate = response.candidates?.[0];
  const finishReason = candidate?.finishReason;
  const blockReason = response.promptFeedback?.blockReason;

  if (finishReason === undefined && blockReason === undefined) {
    return undefined;
  }

  return {
    ...(finishReason !== undefined ? { rawFinishReason: finishReason } : {}),
    ...(blockReason !== undefined ? { promptBlockReason: blockReason } : {}),
    contentBlockCount: content.length,
  };
}

export function createGeminiClient(
  apiKey: string,
  model: string,
  geminiClient?: GeminiClientLike,
): LLMClient {
  const client = geminiClient ?? new GoogleGenAI({ apiKey });
  const defaultModel = stripProviderPrefix(model);

  return {
    async chat(request: ChatRequest): Promise<ChatResponse> {
      const response = await client.models.generateContent({
        model: request.model || defaultModel,
        contents: toGeminiContents(request.messages),
        config: {
          maxOutputTokens: request.maxTokens,
          temperature: request.temperature,
          thinkingConfig: request.thinkingLevel
            ? { thinkingLevel: toGeminiThinkingLevel(request.thinkingLevel) }
            : undefined,
          responseMimeType: request.responseSchema ? "application/json" : undefined,
          responseJsonSchema: request.responseSchema
            ? sanitizeJsonSchema(request.responseSchema)
            : undefined,
          systemInstruction: request.system,
          tools: toGeminiTools(request.tools),
        },
      });

      const content = toContentBlocks(response);

      return {
        content,
        usage: toUsage(response),
        stopReason: toStopReason(response, content),
        providerMetadata: toResponseMetadata(response, content),
      };
    },
  };
}
