import assert from "node:assert/strict";
import test from "node:test";
import type OpenAI from "openai";

import { createOpenAIClient } from "../src/provider-openai.ts";

test("OpenAI provider translates Responses API requests and tool calls", async () => {
  let requestBody: unknown;
  const fakeClient = {
    responses: {
      async create(body: unknown) {
        requestBody = body;
        return {
          id: "resp_123",
          output_text: "",
          output: [
            {
              type: "reasoning",
              id: "rs_2",
              summary: [],
              encrypted_content: "encrypted-new-reasoning",
              status: "completed",
            },
            {
              type: "function_call",
              id: "fc_2",
              call_id: "call_2",
              name: "lookup",
              arguments: '{"query":"AI"}',
              status: "completed",
            },
          ],
          usage: {
            input_tokens: 14,
            output_tokens: 15,
            output_tokens_details: { reasoning_tokens: 6 },
          },
          status: "completed",
          incomplete_details: null,
        };
      },
    },
  } as unknown as Pick<OpenAI, "responses">;

  const client = createOpenAIClient("test-key", "openai/gpt-5.4-mini", fakeClient);
  const response = await client.chat({
    model: "gpt-5.4-mini",
    maxTokens: 512,
    system: "System prompt",
    temperature: 0.2,
    thinkingLevel: "minimal",
    messages: [
      { role: "user", content: "Hello" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Checking." },
          {
            type: "tool_use",
            id: "call_1",
            name: "search",
            input: { query: "prior" },
            providerMetadata: {
              openaiItemId: "fc_1",
              rawArguments: '{"query":"prior"}',
              openaiReasoningItems: [{
                type: "reasoning",
                id: "rs_1",
                summary: [],
                encrypted_content: "encrypted-prior-reasoning",
                status: "completed",
              }],
            },
          },
        ],
      },
      {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "call_1",
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
      properties: { answer: { type: "string" } },
      required: ["answer"],
    },
  });

  const body = requestBody as {
    model: string;
    instructions: string;
    input: unknown[];
    max_output_tokens: number;
    temperature?: number;
    reasoning: { effort: string };
    tools: Array<Record<string, unknown>>;
    text: { format: Record<string, unknown> };
    include: string[];
    store: boolean;
  };

  assert.equal(body.model, "gpt-5.4-mini");
  assert.equal(body.instructions, "System prompt");
  assert.equal(body.max_output_tokens, 512);
  assert.equal(body.temperature, undefined);
  assert.deepEqual(body.reasoning, { effort: "low" });
  assert.deepEqual(body.include, ["reasoning.encrypted_content"]);
  assert.equal(body.store, false);
  assert.deepEqual(body.input, [
    { role: "user", content: "Hello" },
    { role: "assistant", content: "Checking." },
    {
      type: "reasoning",
      id: "rs_1",
      summary: [],
      encrypted_content: "encrypted-prior-reasoning",
      status: "completed",
    },
    {
      type: "function_call",
      call_id: "call_1",
      name: "search",
      arguments: '{"query":"prior"}',
      id: "fc_1",
    },
    {
      type: "function_call_output",
      call_id: "call_1",
      output: "prior result",
    },
  ]);
  assert.deepEqual(body.tools[0], {
    type: "function",
    name: "lookup",
    description: "Search",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
    strict: false,
  });
  assert.equal(body.text.format.type, "json_schema");
  assert.equal(body.text.format.name, "newsteam_response");

  assert.deepEqual(response.content, [{
    type: "tool_use",
    id: "call_2",
    name: "lookup",
    input: { query: "AI" },
    providerMetadata: {
      openaiItemId: "fc_2",
      rawArguments: '{"query":"AI"}',
      openaiReasoningItems: [{
        type: "reasoning",
        id: "rs_2",
        summary: [],
        encrypted_content: "encrypted-new-reasoning",
        status: "completed",
      }],
    },
  }]);
  assert.deepEqual(response.usage, {
    inputTokens: 14,
    outputTokens: 9,
    thinkingTokens: 6,
    billedOutputTokens: 15,
  });
  assert.equal(response.stopReason, "tool_use");
});

test("OpenAI provider maps incomplete output and refusal text", async () => {
  const fakeClient = {
    responses: {
      async create() {
        return {
          id: "resp_incomplete",
          output_text: "",
          output: [{
            type: "message",
            id: "msg_1",
            role: "assistant",
            status: "incomplete",
            content: [{ type: "refusal", refusal: "I cannot do that." }],
          }],
          usage: null,
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
        };
      },
    },
  } as unknown as Pick<OpenAI, "responses">;

  const client = createOpenAIClient("test-key", "openai/gpt-5.4-mini", fakeClient);
  const response = await client.chat({
    model: "",
    maxTokens: 10,
    system: "System",
    messages: [{ role: "user", content: "Hello" }],
  });

  assert.deepEqual(response.content, [{
    type: "text",
    text: "I cannot do that.",
    providerMetadata: { openaiItemId: "msg_1" },
  }]);
  assert.deepEqual(response.usage, {
    inputTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    billedOutputTokens: 0,
  });
  assert.equal(response.stopReason, "max_tokens");
  assert.deepEqual(response.providerMetadata, {
    responseId: "resp_incomplete",
    status: "incomplete",
    incompleteReason: "max_output_tokens",
    outputItemCount: 1,
  });
});
