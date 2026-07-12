/**
 * Conversation context management: token estimation, message
 * truncation, summarization, and API retry logic.
 *
 * Extracted from agent.ts to keep files under 500 lines.
 */

import { extractVisibleText, stripThoughtTextBlocks } from "./agent-tools.ts";
import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  LLMClient,
  TextBlock,
  ThinkingLevel,
} from "./llm-types.ts";
import type { EventLogger } from "./logger.ts";

// ── Token estimation ─────────────────────────────────────────────

function estimateBlockChars(block: unknown): number {
  if (typeof block === "string") {
    return block.length;
  }

  if (typeof block !== "object" || block === null) {
    return 0;
  }

  const record = block as Record<string, unknown>;

  if (record.type === "text" && typeof record.text === "string") {
    return record.text.length;
  }

  if (record.type === "tool_use") {
    return (
      (typeof record.name === "string" ? record.name.length : 0) +
      JSON.stringify(record.input ?? {}).length
    );
  }

  if (record.type === "tool_result") {
    const content = record.content;
    if (typeof content === "string") {
      return content.length;
    }

    if (Array.isArray(content)) {
      return content.reduce(
        (total: number, inner: unknown) => total + estimateBlockChars(inner),
        0,
      );
    }

    return 0;
  }

  return JSON.stringify(block).length;
}

function estimateMessageChars(message: ChatMessage): number {
  if (typeof message.content === "string") {
    return message.content.length;
  }

  return message.content.reduce(
    (total, block) => total + estimateBlockChars(block),
    0,
  );
}

export function estimatePromptTokens(
  systemPrompt: string,
  apiMessages: ChatMessage[],
): number {
  const totalChars =
    systemPrompt.length +
    apiMessages.reduce(
      (sum, message) => sum + estimateMessageChars(message),
      0,
    );

  return Math.ceil(totalChars / 4);
}

// ── Message truncation ───────────────────────────────────────────

function isToolResultMessage(message: ChatMessage): boolean {
  if (message.role !== "user" || typeof message.content === "string") {
    return false;
  }

  return message.content.length > 0 && message.content.every((block) => {
    if (typeof block !== "object" || block === null) {
      return false;
    }

    return (block as { type?: unknown }).type === "tool_result";
  });
}

function isAssistantToolUseMessage(message: ChatMessage): boolean {
  if (message.role !== "assistant" || typeof message.content === "string") {
    return false;
  }

  return message.content.some((block) => {
    if (typeof block !== "object" || block === null) {
      return false;
    }

    return (block as { type?: unknown }).type === "tool_use";
  });
}

type MessageUnit = {
  start: number;
  end: number;
};

function buildMessageUnits(apiMessages: ChatMessage[]): MessageUnit[] {
  const units: MessageUnit[] = [];

  for (let index = 0; index < apiMessages.length; index += 1) {
    const current = apiMessages[index];
    const next = apiMessages[index + 1];

    if (isAssistantToolUseMessage(current) && next && isToolResultMessage(next)) {
      units.push({ start: index, end: index + 2 });
      index += 1;
      continue;
    }

    units.push({ start: index, end: index + 1 });
  }

  return units;
}

function findMostRecentSubstantiveUserMessageIndex(
  apiMessages: ChatMessage[],
): number {
  for (let index = apiMessages.length - 1; index >= 0; index -= 1) {
    if (apiMessages[index]?.role === "user" && !isToolResultMessage(apiMessages[index])) {
      return index;
    }
  }

  return -1;
}

function findProtectedUnitStartIndex(apiMessages: ChatMessage[]): number {
  const protectedMessageIndex = findMostRecentSubstantiveUserMessageIndex(apiMessages);
  const units = buildMessageUnits(apiMessages);

  if (units.length === 0) {
    return -1;
  }

  if (protectedMessageIndex === -1) {
    return units[units.length - 1]!.start;
  }

  return units.find(
    (unit) => unit.start <= protectedMessageIndex && protectedMessageIndex < unit.end,
  )?.start ?? units[units.length - 1]!.start;
}

export function truncateMessages(
  apiMessages: ChatMessage[],
  systemPrompt: string,
  maxInputTokens: number,
): void {
  while (
    apiMessages.length > 0 &&
    estimatePromptTokens(systemPrompt, apiMessages) > maxInputTokens
  ) {
    const protectedUnitStart = findProtectedUnitStartIndex(apiMessages);
    const removableUnit = buildMessageUnits(apiMessages).find(
      (unit) => unit.end <= protectedUnitStart,
    );

    if (!removableUnit) {
      break;
    }

    apiMessages.splice(removableUnit.start, removableUnit.end - removableUnit.start);
  }
}

// ── Summarization ────────────────────────────────────────────────

export async function summarizeOlderMessages(
  apiMessages: ChatMessage[],
  systemPrompt: string,
  maxInputTokens: number,
  summaryMaxTokens: number,
  llmClient: LLMClient,
  modelName: string,
  onSummarizationUsage?: (usage: ChatResponse["usage"]) => void,
): Promise<void> {
  const protectedUserIndex = findMostRecentSubstantiveUserMessageIndex(apiMessages);

  if (protectedUserIndex <= 0) {
    truncateMessages(apiMessages, systemPrompt, maxInputTokens);
    return;
  }

  const messagesToSummarize = apiMessages.slice(0, protectedUserIndex);

  if (messagesToSummarize.length === 0) {
    truncateMessages(apiMessages, systemPrompt, maxInputTokens);
    return;
  }

  const formattedMessages = messagesToSummarize
    .map((msg) => {
      const content =
        typeof msg.content === "string"
          ? msg.content
          : JSON.stringify(msg.content);
      return `${msg.role}: ${content}`;
    })
    .join("\n");

  const summaryResponse = await llmClient.chat({
    model: modelName,
    maxTokens: summaryMaxTokens,
    system:
      "Summarize the following conversation into 3 concise bullet points. Focus on key facts, decisions, and context needed to continue the conversation.",
    messages: [{
      role: "user",
      content: formattedMessages,
    }],
  });

  onSummarizationUsage?.(summaryResponse.usage);

  const summaryText = summaryResponse.content
    .filter((block): block is TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n");

  if (summaryText.length === 0) {
    truncateMessages(apiMessages, systemPrompt, maxInputTokens);
    return;
  }

  const protectedMessages = apiMessages.slice(protectedUserIndex);
  apiMessages.length = 0;
  apiMessages.push({
    role: "user",
    content: `[Previous conversation summary]\n${summaryText}`,
  });

  for (const msg of protectedMessages) {
    apiMessages.push(msg);
  }

  if (estimatePromptTokens(systemPrompt, apiMessages) > maxInputTokens) {
    truncateMessages(apiMessages, systemPrompt, maxInputTokens);
  }
}

// ── Trim dispatcher ──────────────────────────────────────────────

export async function trimMessagesToBudget(
  apiMessages: ChatMessage[],
  systemPrompt: string,
  maxInputTokens: number,
  summaryMaxTokens: number,
  contextStrategy: string,
  llmClient: LLMClient,
  modelName: string,
  onSummarizationUsage?: (usage: ChatResponse["usage"]) => void,
): Promise<void> {
  if (estimatePromptTokens(systemPrompt, apiMessages) <= maxInputTokens) {
    return;
  }

  if (contextStrategy === "summarize") {
    try {
      await summarizeOlderMessages(
        apiMessages,
        systemPrompt,
        maxInputTokens,
        summaryMaxTokens,
        llmClient,
        modelName,
        onSummarizationUsage,
      );
      return;
    } catch {
      // Fall through to truncation
    }
  }

  truncateMessages(apiMessages, systemPrompt, maxInputTokens);
}

// ── Final direct answer ──────────────────────────────────────────

const OUT_OF_TOOL_TURNS_PROMPT =
  "You are out of tool turns. Reply directly to the user now using only the information already gathered. Do not call tools. If you were working through a tool-driven task, summarize the current state, what happened, and the best next action.";

/**
 * When the final allowed turn still returned tool calls, make one last
 * tool-free request for a direct answer. Returns the visible text
 * (possibly empty), or null if the request failed.
 */
export async function requestFinalDirectAnswer(input: {
  llmClient: LLMClient;
  apiMessages: ChatMessage[];
  systemPrompt: string;
  model: string;
  maxTokens: number;
  maxInputTokens: number;
  summaryMaxTokens: number;
  contextStrategy: string;
  trimModelName: string;
  thinkingLevel?: ThinkingLevel;
  retryBaseDelayMs: number;
  logger?: EventLogger;
  logData?: (data: Record<string, unknown>) => Record<string, unknown>;
  onSummarizationUsage?: (usage: ChatResponse["usage"]) => void;
  onResponse: (
    response: ChatResponse,
    meta: {
      messagesBeforeTrim: number;
      estimatedPromptTokensBeforeTrim: number;
      requestMessages: ChatMessage[];
    },
  ) => void;
}): Promise<string | null> {
  const messages: ChatMessage[] = [
    ...input.apiMessages,
    { role: "user", content: OUT_OF_TOOL_TURNS_PROMPT },
  ];
  const messagesBeforeTrim = messages.length;
  const estimatedPromptTokensBeforeTrim = estimatePromptTokens(input.systemPrompt, messages);

  await trimMessagesToBudget(
    messages,
    input.systemPrompt,
    input.maxInputTokens,
    input.summaryMaxTokens,
    input.contextStrategy,
    input.llmClient,
    input.trimModelName,
    input.onSummarizationUsage,
  );

  try {
    const response = await callWithRetry(
      input.llmClient,
      {
        model: input.model,
        maxTokens: input.maxTokens,
        system: input.systemPrompt,
        messages,
        thinkingLevel: input.thinkingLevel,
      },
      input.retryBaseDelayMs,
      input.logger,
      input.logData,
    );

    input.onResponse(response, {
      messagesBeforeTrim,
      estimatedPromptTokensBeforeTrim,
      requestMessages: messages,
    });

    return extractVisibleText(stripThoughtTextBlocks(response.content));
  } catch {
    return null;
  }
}

// ── API retry ────────────────────────────────────────────────────

export async function callWithRetry(
  llmClient: LLMClient,
  request: ChatRequest,
  retryBaseDelayMs: number,
  logger?: EventLogger,
  logData?: (data: Record<string, unknown>) => Record<string, unknown>,
): Promise<ChatResponse> {
  const MAX_RETRIES = 3;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await llmClient.chat(request);
    } catch (err) {
      const isLastAttempt = attempt === MAX_RETRIES;
      const errMsg = err instanceof Error ? err.message : String(err);

      logger?.emit("agent.api.retry", logData?.({
        attempt,
        error: errMsg,
        is_final: isLastAttempt,
      }) ?? { attempt, error: errMsg, is_final: isLastAttempt });

      if (isLastAttempt) {
        throw err;
      }

      const delay = retryBaseDelayMs * Math.pow(2, attempt - 1);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw new Error("Retry loop exited unexpectedly");
}
