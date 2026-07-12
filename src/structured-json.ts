/**
 * Structured JSON response handling: lenient parsing of model output
 * (code fences, YAML fallback) and JSON-schema-subset validation.
 *
 * Extracted from agent-eval.ts to keep files under 500 lines.
 */

import yaml from "js-yaml";

import type { ChatResponse, TextBlock } from "./llm-types.ts";

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripCodeFences(text: string): string {
  return text.replace(/^```(?:json)?\s*/u, "").replace(/\s*```\s*$/u, "").trim();
}

function extractJsonObject(text: string): string {
  const cleaned = stripCodeFences(text);
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");

  if (start === -1 || end === -1 || end < start) {
    return cleaned;
  }

  return cleaned.slice(start, end + 1);
}

export function parseJsonObject(text: string): Record<string, unknown> {
  const cleaned = extractJsonObject(text);

  try {
    return JSON.parse(cleaned) as Record<string, unknown>;
  } catch (jsonError) {
    try {
      const parsed = yaml.load(cleaned);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Fall through and preserve the original JSON error below.
    }

    throw jsonError;
  }
}

export type StructuredJsonError = Error & { responseText?: string };
export type StructuredJsonResult = {
  parsed: Record<string, unknown>;
  responseText: string;
  attemptCount: number;
  usedRepair: boolean;
  usedStrictRetry: boolean;
  validationError: string | null;
};

export function withResponseText(
  error: unknown,
  responseText: string,
): StructuredJsonError {
  const wrapped = new Error(error instanceof Error ? error.message : String(error)) as StructuredJsonError;
  const fullText = responseText.trim();
  if (fullText.length > 0) {
    wrapped.responseText = fullText;
  }
  return wrapped;
}

export function extractTextContent(response: ChatResponse): string {
  return response.content
    .filter((b): b is TextBlock => b.type === "text")
    .filter((block) => {
      const metadata = block.providerMetadata;
      return !(isPlainObject(metadata) && metadata.thought === true);
    })
    .map((b) => b.text)
    .join("");
}

export function validateStructuredValue(
  value: unknown,
  schema: Record<string, unknown>,
  path = "response",
): string | null {
  const expectedType = schema.type;

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    return `Invalid value at ${path}: expected one of ${schema.enum.map(String).join(", ")}`;
  }

  if (expectedType === "object") {
    if (!isPlainObject(value)) {
      return `Invalid type at ${path}: expected object`;
    }

    const properties = isPlainObject(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required)
      ? schema.required.filter((entry): entry is string => typeof entry === "string")
      : [];

    for (const field of required) {
      if (!(field in value)) {
        return `Missing required field: ${path}.${field}`;
      }
    }

    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) {
          return `Unexpected field at ${path}.${key}`;
        }
      }
    }

    for (const [key, childSchema] of Object.entries(properties)) {
      if (!(key in value) || !isPlainObject(childSchema)) {
        continue;
      }

      const nestedError = validateStructuredValue(value[key], childSchema, `${path}.${key}`);
      if (nestedError) {
        return nestedError;
      }
    }

    return null;
  }

  if (expectedType === "array") {
    if (!Array.isArray(value)) {
      return `Invalid type at ${path}: expected array`;
    }

    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      return `Invalid length at ${path}: expected at least ${schema.minItems} items`;
    }

    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      return `Invalid length at ${path}: expected at most ${schema.maxItems} items`;
    }

    if (isPlainObject(schema.items)) {
      for (let index = 0; index < value.length; index += 1) {
        const nestedError = validateStructuredValue(
          value[index],
          schema.items,
          `${path}[${index}]`,
        );
        if (nestedError) {
          return nestedError;
        }
      }
    }

    return null;
  }

  if (expectedType === "string") {
    if (typeof value !== "string") {
      return `Invalid type at ${path}: expected string`;
    }

    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      return `Invalid length at ${path}: expected at least ${schema.minLength} characters`;
    }

    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      return `Invalid length at ${path}: expected at most ${schema.maxLength} characters`;
    }

    return null;
  }

  if (expectedType === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return `Invalid type at ${path}: expected number`;
    }

    if (typeof schema.minimum === "number" && value < schema.minimum) {
      return `Invalid value at ${path}: expected >= ${schema.minimum}`;
    }

    if (typeof schema.maximum === "number" && value > schema.maximum) {
      return `Invalid value at ${path}: expected <= ${schema.maximum}`;
    }

    return null;
  }

  if (expectedType === "boolean" && typeof value !== "boolean") {
    return `Invalid type at ${path}: expected boolean`;
  }

  return null;
}
