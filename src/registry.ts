import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export interface ToolManifest {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  secrets: string[];
  timeout_ms: number;
  handler: string;
  runtime: string;
  // Optional hardening fields (not in REQUIRED_FIELDS)
  requires_confirmation?: boolean;
  output_schema?: Record<string, unknown>;
  max_calls_per_hour?: number;
}

const REQUIRED_FIELDS: (keyof ToolManifest)[] = [
  "name",
  "description",
  "parameters",
  "secrets",
  "timeout_ms",
  "handler",
  "runtime",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatEnumValue(value: unknown): string {
  return typeof value === "string" ? `"${value}"` : String(value);
}

export function validateToolArgs(
  args: Record<string, unknown>,
  schema: Record<string, unknown>,
): string | null {
  if (!isRecord(args)) {
    return "Tool arguments must be an object.";
  }

  const requiredFields = Array.isArray(schema.required)
    ? schema.required.filter((field): field is string => typeof field === "string")
    : [];
  const properties = isRecord(schema.properties) ? schema.properties : {};

  for (const field of requiredFields) {
    if (!(field in args) || args[field] === undefined) {
      return `Missing required field: ${field}`;
    }
  }

  for (const [field, value] of Object.entries(args)) {
    const propertySchema = properties[field];

    if (!isRecord(propertySchema)) {
      continue;
    }

    if (propertySchema.type === "string" && typeof value !== "string") {
      return `Invalid type for "${field}": expected string`;
    }

    if (propertySchema.type === "number" && typeof value !== "number") {
      return `Invalid type for "${field}": expected number`;
    }

    if (Array.isArray(propertySchema.enum) && !propertySchema.enum.includes(value)) {
      const allowedValues = propertySchema.enum.map(formatEnumValue).join(", ");
      return `Invalid value for "${field}": expected one of ${allowedValues}`;
    }
  }

  return null;
}

export class ToolRegistry {
  private readonly toolsDir: string;
  private readonly manifests = new Map<string, ToolManifest>();

  constructor(toolsDir: string) {
    this.toolsDir = toolsDir;
  }

  loadAll(): void {
    if (!existsSync(this.toolsDir)) {
      return;
    }

    const entries = readdirSync(this.toolsDir);

    for (const entry of entries) {
      const fullPath = path.join(this.toolsDir, entry);

      if (!statSync(fullPath).isDirectory()) {
        continue;
      }

      const manifestPath = path.join(fullPath, "manifest.json");

      if (!existsSync(manifestPath)) {
        // Skip directories without a manifest (disabled tools keep
        // their files on disk but rename manifest.json to .disabled)
        continue;
      }

      const raw = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<
        string,
        unknown
      >;

      for (const field of REQUIRED_FIELDS) {
        if (raw[field] === undefined || raw[field] === null) {
          throw new Error(
            `Tool "${entry}" manifest is missing required field: ${field}`,
          );
        }
      }

      const manifest = raw as unknown as ToolManifest;
      this.manifests.set(manifest.name, manifest);
    }
  }

  get(name: string): ToolManifest | undefined {
    return this.manifests.get(name);
  }

  getAll(): ToolManifest[] {
    return [...this.manifests.values()];
  }

  validateToolArgs(
    args: Record<string, unknown>,
    schema: Record<string, unknown>,
  ): string | null {
    return validateToolArgs(args, schema);
  }

  getToolSchemas(): Array<{
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
  }> {
    return this.getAll().map((manifest) => ({
      name: manifest.name,
      description: manifest.description,
      input_schema: manifest.parameters,
    }));
  }
}
