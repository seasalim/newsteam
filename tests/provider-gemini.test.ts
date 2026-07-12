import assert from "node:assert/strict";
import test from "node:test";
import type { GoogleGenAI } from "@google/genai";

import type { ChatRequest } from "../src/llm-types.ts";
import { createGeminiClient } from "../src/provider-gemini.ts";

test("Gemini provider translates neutral request payloads", async () => {
  let requestBody: unknown;
  const fakeClient = {
    models: {
      async generateContent(body: unknown) {
        requestBody = body;
        return {
          responseId: "resp_req",
          candidates: [{
            content: { parts: [{ text: "ok" }] },
            finishReason: "STOP",
          }],
          usageMetadata: {
            promptTokenCount: 11,
            candidatesTokenCount: 7,
          },
        };
      },
    },
  } as Pick<GoogleGenAI, "models">;

  const client = createGeminiClient("test-key", "google/gemini-3-flash", fakeClient);
  await client.chat({
    model: "gemini-3-flash",
    maxTokens: 256,
    system: "System instructions",
    messages: [
      { role: "user", content: "Hello" },
      {
        role: "assistant",
        content: [{
          type: "tool_use",
          id: "toolu_1",
          name: "lookup",
          input: { query: "Gemini" },
        }],
      },
      {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "toolu_1",
          content: "Tool output",
        }],
      },
    ],
    tools: [{
      name: "lookup",
      description: "Search for something",
      input_schema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          query: {
            type: "string",
            default: "ignored",
          },
        },
        required: ["query"],
      },
    }],
  });

  const body = requestBody as {
    model: string;
    contents: Array<{ role: string; parts: Array<Record<string, unknown>> }>;
    config: {
      maxOutputTokens: number;
      systemInstruction: string;
      tools: Array<{ functionDeclarations: Array<{ parametersJsonSchema: Record<string, unknown> }> }>;
    };
  };

  assert.equal(body.model, "gemini-3-flash");
  assert.equal(body.config.maxOutputTokens, 256);
  assert.equal(body.config.systemInstruction, "System instructions");
  assert.equal(body.contents[0]?.role, "user");
  assert.deepEqual(body.contents[0]?.parts, [{ text: "Hello" }]);
  assert.deepEqual(body.contents[1]?.parts, [{
    functionCall: {
      id: "toolu_1",
      name: "lookup",
      args: { query: "Gemini" },
    },
  }]);
  assert.deepEqual(body.contents[2]?.parts, [{
    functionResponse: {
      id: "toolu_1",
      name: "lookup",
      response: { output: "Tool output" },
    },
  }]);
  assert.equal(body.config.tools[0]?.functionDeclarations[0]?.parametersJsonSchema.type, "object");
  assert.equal(
    body.config.tools[0]?.functionDeclarations[0]?.parametersJsonSchema.properties?.query?.type,
    "string",
  );
  assert.equal(
    "default" in (body.config.tools[0]?.functionDeclarations[0]?.parametersJsonSchema.properties?.query as Record<string, unknown>),
    false,
  );
});

test("Gemini provider translates function calls back into tool_use blocks", async () => {
  const fakeClient = {
    models: {
      async generateContent() {
        return {
          responseId: "resp_tool",
          candidates: [{
            content: {
              parts: [
                { text: "Need a tool." },
                { functionCall: { name: "lookup", args: { query: "AI" } } },
              ],
            },
            finishReason: "STOP",
          }],
          usageMetadata: {
            promptTokenCount: 33,
            candidatesTokenCount: 12,
          },
        };
      },
    },
  } as Pick<GoogleGenAI, "models">;

  const client = createGeminiClient("test-key", "google/gemini-3-flash", fakeClient);
  const response = await client.chat({
    model: "gemini-3-flash",
    maxTokens: 128,
    system: "",
    messages: [{ role: "user", content: "Search for AI" }],
  });

  assert.equal(response.stopReason, "tool_use");
  assert.equal(response.usage.inputTokens, 33);
  assert.equal(response.usage.outputTokens, 12);
  assert.equal(response.content[0]?.type, "text");
  assert.equal(response.content[1]?.type, "tool_use");
  assert.equal(response.content[1]?.name, "lookup");
  assert.deepEqual(response.content[1]?.type === "tool_use" ? response.content[1].input : null, { query: "AI" });
  assert.match(response.content[1]?.type === "tool_use" ? response.content[1].id : "", /^toolu_gemini_/u);
});

test("Gemini provider forwards thinking level and reports thinking tokens", async () => {
  let requestBody: unknown;
  const fakeClient = {
    models: {
      async generateContent(body: unknown) {
        requestBody = body;
        return {
          responseId: "resp_think",
          candidates: [{
            content: { parts: [{ text: "ok" }] },
            finishReason: "MAX_TOKENS",
          }],
          usageMetadata: {
            promptTokenCount: 20,
            candidatesTokenCount: 40,
            thoughtsTokenCount: 150,
          },
        };
      },
    },
  } as Pick<GoogleGenAI, "models">;

  const client = createGeminiClient("test-key", "google/gemini-3.1-pro", fakeClient);
  const response = await client.chat({
    model: "gemini-3.1-pro",
    maxTokens: 128,
    system: "",
    messages: [{ role: "user", content: "Think carefully" }],
    thinkingLevel: "low",
  });

  const body = requestBody as {
    config?: {
      thinkingConfig?: { thinkingLevel?: string };
    };
  };
  assert.equal(body.config?.thinkingConfig?.thinkingLevel, "LOW");
  assert.equal(response.usage.outputTokens, 40);
  assert.equal(response.usage.thinkingTokens, 150);
  assert.equal(response.usage.billedOutputTokens, 190);
});

test("Gemini provider maps MAX_TOKENS to max_tokens stop reason", async () => {
  const fakeClient = {
    models: {
      async generateContent() {
        return {
          responseId: "resp_max",
          candidates: [{
            content: { parts: [{ text: "Partial answer" }] },
            finishReason: "MAX_TOKENS",
          }],
          usageMetadata: {
            promptTokenCount: 9,
            candidatesTokenCount: 99,
          },
        };
      },
    },
  } as Pick<GoogleGenAI, "models">;

  const client = createGeminiClient("test-key", "google/gemini-3.1-pro", fakeClient);
  const response = await client.chat({
    model: "gemini-3.1-pro",
    maxTokens: 64,
    system: "",
    messages: [{ role: "user", content: "Explain everything" }],
  });

  assert.equal(response.stopReason, "max_tokens");
  assert.equal(response.content[0]?.type, "text");
  assert.equal(response.content[0]?.type === "text" ? response.content[0].text : "", "Partial answer");
});

test("Gemini provider preserves raw finish metadata for empty responses", async () => {
  const fakeClient = {
    models: {
      async generateContent() {
        return {
          responseId: "resp_empty",
          candidates: [{
            content: { parts: [] },
            finishReason: "SAFETY",
          }],
          promptFeedback: {
            blockReason: "SAFETY",
          },
          usageMetadata: {
            promptTokenCount: 14,
            candidatesTokenCount: 0,
          },
        };
      },
    },
  } as Pick<GoogleGenAI, "models">;

  const client = createGeminiClient("test-key", "google/gemini-3.1-pro", fakeClient);
  const response = await client.chat({
    model: "gemini-3.1-pro",
    maxTokens: 64,
    system: "",
    messages: [{ role: "user", content: "Explain" }],
  });

  assert.equal(response.stopReason, "end_turn");
  assert.deepEqual(response.providerMetadata, {
    rawFinishReason: "SAFETY",
    promptBlockReason: "SAFETY",
    contentBlockCount: 0,
  });
});

test("Gemini provider preserves thought signatures across function-call turns", async () => {
  const requests: unknown[] = [];
  const fakeClient = {
    models: {
      async generateContent(body: unknown) {
        requests.push(body);

        if (requests.length === 1) {
          return {
            responseId: "resp_sig_1",
            candidates: [{
              content: {
                parts: [{
                  functionCall: {
                    id: "toolu_sig_1",
                    name: "lookup",
                    args: { query: "policy" },
                  },
                  thoughtSignature: "sig_123",
                }],
              },
              finishReason: "STOP",
            }],
            usageMetadata: {
              promptTokenCount: 10,
              candidatesTokenCount: 5,
            },
          };
        }

        return {
          responseId: "resp_sig_2",
          candidates: [{
            content: { parts: [{ text: "done" }] },
            finishReason: "STOP",
          }],
          usageMetadata: {
            promptTokenCount: 12,
            candidatesTokenCount: 4,
          },
        };
      },
    },
  } as Pick<GoogleGenAI, "models">;

  const client = createGeminiClient("test-key", "google/gemini-3-flash", fakeClient);
  const first = await client.chat({
    model: "gemini-3-flash",
    maxTokens: 128,
    system: "",
    tools: [{
      name: "lookup",
      description: "Search",
      input_schema: { type: "object", properties: { query: { type: "string" } } },
    }],
    messages: [{ role: "user", content: "search policy" }],
  });

  await client.chat({
    model: "gemini-3-flash",
    maxTokens: 128,
    system: "",
    messages: [
      { role: "user", content: "search policy" },
      { role: "assistant", content: first.content },
      {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "toolu_sig_1",
          content: "result text",
        }],
      },
    ],
  });

  const secondRequest = requests[1] as {
    contents: Array<{ parts: Array<Record<string, unknown>> }>;
  };

  assert.equal(
    secondRequest.contents[1]?.parts[0]?.thoughtSignature,
    "sig_123",
  );
});

test("Gemini provider uses responseSchema directly for structured responses", async () => {
  let requestBody: unknown;
  const fakeClient = {
    models: {
      async generateContent(body: unknown) {
        requestBody = body;
        return {
          responseId: "resp_json",
          candidates: [{
            content: { parts: [{ text: "{\"ok\":true}" }] },
            finishReason: "STOP",
          }],
          usageMetadata: {
            promptTokenCount: 3,
            candidatesTokenCount: 2,
          },
        };
      },
    },
  } as Pick<GoogleGenAI, "models">;

  const client = createGeminiClient("test-key", "google/gemini-3-flash", fakeClient);
  const request: ChatRequest = {
    model: "gemini-3-flash",
    maxTokens: 32,
    system: "Return JSON",
    messages: [{ role: "user", content: "score this" }],
    responseSchema: {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        summary: { type: "string", minLength: 1 },
      },
      required: ["ok", "summary"],
      additionalProperties: false,
    },
  };

  await client.chat(request);

  const body = requestBody as {
    config: {
      responseMimeType?: string;
      responseJsonSchema?: {
        type?: string;
        properties?: Record<string, unknown>;
      };
    };
  };
  assert.equal(body.config.responseMimeType, "application/json");
  assert.equal(body.config.responseJsonSchema?.type, "object");
  assert.ok(body.config.responseJsonSchema?.properties?.ok);
  assert.equal(
    (body.config.responseJsonSchema?.properties?.summary as { minLength?: number } | undefined)?.minLength,
    1,
  );
});
