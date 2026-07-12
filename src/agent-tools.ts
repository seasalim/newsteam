/**
 * Tool-use dispatch for the agent loop: the built-in remember tool,
 * external tool execution with validation and confirmation gates.
 *
 * Extracted from agent.ts to keep files under 500 lines.
 */

import type { BudgetTracker } from "./budget.js";
import type { ToolExecutor } from "./executor.js";
import type {
  ContentBlock,
  TextBlock,
  ToolResultBlock,
  ToolSchema,
  ToolUseBlock,
} from "./llm-types.ts";
import type { EventLogger } from "./logger.js";
import type { MemoryManager } from "./memory.js";
import type { ToolRegistry } from "./registry.js";
export type ConfirmFn = (toolName: string, args: Record<string, unknown>, channelId: string) => Promise<boolean>;

export interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
}

export const REMEMBER_SCHEMA: ToolSchema = {
  name: "remember",
  description: "Save a fact to long-term memory. Use ONLY for: user preferences, important names/relationships, key decisions. Do NOT use for: things you just looked up, conversation summaries, transient details. When in doubt, don't call this.",
  input_schema: {
    type: "object" as const,
    properties: {
      text: {
        type: "string",
        description: "The fact or context to remember",
      },
      category: {
        type: "string",
        description: "Category for this memory: preference, fact, relationship, decision, or general",
        enum: ["preference", "fact", "relationship", "decision", "general"],
      },
    },
    required: ["text"],
  },
};

function isThoughtTextBlock(block: TextBlock): boolean {
  const metadata = block.providerMetadata;
  return typeof metadata === "object" && metadata !== null && metadata.thought === true;
}

export function stripThoughtTextBlocks(content: ContentBlock[]): ContentBlock[] {
  return content.filter((block) => block.type !== "text" || !isThoughtTextBlock(block));
}

export function extractVisibleText(content: ContentBlock[]): string {
  return content
    .filter((block): block is TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

export interface ToolDispatchDeps {
  memory: MemoryManager;
  budget: BudgetTracker;
  registry?: ToolRegistry;
  executor?: ToolExecutor;
  logger?: EventLogger;
  confirmFn?: ConfirmFn;
  envOverrides?: Record<string, string>;
  agentId: string;
  personaDir: string;
  logData: (data: Record<string, unknown>) => Record<string, unknown>;
}

export interface ToolDispatchState {
  channelId?: string;
  /** Appended: record of this reply's tool calls. */
  lastToolCalls: ToolCallRecord[];
}

export async function dispatchToolUses(
  deps: ToolDispatchDeps,
  state: ToolDispatchState,
  toolUseBlocks: ToolUseBlock[],
): Promise<ToolResultBlock[]> {
  const { channelId } = state;
  const toolResults: ToolResultBlock[] = [];

  for (const toolUse of toolUseBlocks) {
    // Handle built-in remember tool
    if (toolUse.name === "remember") {
      const input = toolUse.input as Record<string, unknown>;
      const text = typeof input.text === "string" ? input.text : String(input.text);
      const category = typeof input.category === "string" ? input.category : undefined;
      deps.memory.remember(text, category);
      state.lastToolCalls.push({ name: toolUse.name, args: { ...input } });
      toolResults.push({
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: "Remembered.",
      });
      continue;
    }

    // Process external tool calls
    if (!deps.executor || !deps.registry) {
      toolResults.push({
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: "Tool executor not configured.",
        is_error: true,
      });
      continue;
    }

    const manifest = deps.registry.get(toolUse.name);

    if (!manifest) {
      // Hallucinated tool name — let the model recover instead of
      // aborting the whole turn.
      deps.logger?.emit("agent.tool.unknown", deps.logData({ tool_name: toolUse.name }));
      const availableTools = ["remember", ...deps.registry.getAll().map((tool) => tool.name)];
      toolResults.push({
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: `Unknown tool: "${toolUse.name}". Available tools: ${availableTools.join(", ")}. Use one of these or reply directly.`,
        is_error: true,
      });
      continue;
    }

    const validationError = deps.registry.validateToolArgs(
      toolUse.input as Record<string, unknown>,
      manifest.parameters,
    );

    if (validationError) {
      toolResults.push({
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: validationError,
        is_error: true,
      });
      continue;
    }

    const input = toolUse.input as Record<string, unknown>;
    const needsConfirmation = manifest.requires_confirmation === true;
    if (needsConfirmation && deps.confirmFn) {
      const confirmed = await deps.confirmFn(toolUse.name, input, channelId ?? "");
      if (!confirmed) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: "Action cancelled by user. The user declined the confirmation prompt.",
          is_error: true,
        });
        continue;
      }
    }

    try {
      const result = await deps.executor.execute(
        manifest,
        input,
        deps.envOverrides,
        { agentId: deps.agentId, personaDir: deps.personaDir },
      );
      deps.budget.record(0, 0, toolUse.name);
      state.lastToolCalls.push({
        name: toolUse.name,
        args: { ...input },
      });
      toolResults.push({
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: result,
      });
    } catch (err) {
      // Tool failure — strict abort, no retry, discard pending memory
      deps.budget.record(0, 0, toolUse.name);
      deps.memory.discardPending();
      const msg =
        err instanceof Error ? err.message : String(err);
      throw new Error(`Tool execution failed: ${msg}`);
    }
  }

  return toolResults;
}
