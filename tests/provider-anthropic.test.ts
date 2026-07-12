import assert from "node:assert/strict";
import test from "node:test";
import type Anthropic from "@anthropic-ai/sdk";

import { createAnthropicClient } from "../src/provider-anthropic.ts";

test("Anthropic provider translates neutral requests and responses", async () => {
  let requestBody: unknown;
  const fakeClient = {
    messages: {
      async create(body: unknown) {
        requestBody = body;
        return {
          id: "msg_123",
          content: [
            { type: "text", text: "Need a tool" },
            {
              type: "tool_use",
              id: "toolu_123",
              name: "lookup",
              input: { query: "AI" },
            },
          ],
          usage: { input_tokens: 14, output_tokens: 9 },
          stop_reason: "tool_use",
        };
      },
    },
  } as Pick<Anthropic, "messages">;

  const client = createAnthropicClient("test-key", "anthropic/claude-haiku-4-5", fakeClient);
  const response = await client.chat({
    model: "claude-haiku-4-5",
    maxTokens: 512,
    system: "System prompt",
    temperature: 0.2,
    messages: [
      { role: "user", content: "Hello" },
      {
        role: "assistant",
        content: [{
          type: "tool_use",
          id: "toolu_prev",
          name: "search",
          input: { query: "prior" },
        }],
      },
      {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "toolu_prev",
          content: "prior result",
        }],
      },
    ],
    tools: [{
      name: "lookup",
      description: "Search",
      input_schema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    }],
    responseSchema: {
      type: "object",
      properties: { ignored: { type: "boolean" } },
    },
  });

  const body = requestBody as {
    model: string;
    max_tokens: number;
    system: string;
    temperature: number;
    messages: Array<{ role: string; content: unknown }>;
    tools: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>;
  };

  assert.equal(body.model, "claude-haiku-4-5");
  assert.equal(body.max_tokens, 512);
  assert.equal(body.system, "System prompt");
  assert.equal(body.temperature, 0.2);
  assert.deepEqual(body.messages, [
    { role: "user", content: "Hello" },
    {
      role: "assistant",
      content: [{
        type: "tool_use",
        id: "toolu_prev",
        name: "search",
        input: { query: "prior" },
      }],
    },
    {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "toolu_prev",
        content: "prior result",
        is_error: undefined,
      }],
    },
  ]);
  assert.equal(body.tools[0]?.name, "lookup");
  assert.deepEqual(response.content, [
    { type: "text", text: "Need a tool" },
    {
      type: "tool_use",
      id: "toolu_123",
      name: "lookup",
      input: { query: "AI" },
    },
  ]);
  assert.equal(response.usage.inputTokens, 14);
  assert.equal(response.usage.outputTokens, 9);
  assert.equal(response.usage.billedOutputTokens, 9);
  assert.equal(response.stopReason, "tool_use");
});
