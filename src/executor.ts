import { spawn } from "node:child_process";
import path from "node:path";

import type { EventLogger } from "./logger.js";
import type { ToolManifest } from "./registry.js";

export interface ToolExecutionContext {
  agentId?: string;
  personaDir?: string;
}

function redactSecrets(text: string, secrets: string[], env: Record<string, string | undefined>): string {
  let result = text;
  for (const secretName of secrets) {
    const value = env[secretName];
    if (value && value.length > 0) {
      // Replace all occurrences of the secret value
      result = result.replaceAll(value, "[REDACTED]");
    }
  }
  return result;
}

export class ToolExecutor {
  private readonly toolsDir: string;
  private readonly logger?: EventLogger;
  private readonly callCounts = new Map<string, { count: number; windowStart: number }>();

  constructor(toolsDir: string, logger?: EventLogger) {
    this.toolsDir = toolsDir;
    this.logger = logger;
  }

  private checkRateLimit(manifest: ToolManifest): string | null {
    if (!manifest.max_calls_per_hour) return null;

    const now = Date.now();
    const hourMs = 60 * 60 * 1000;
    const key = manifest.name;
    const entry = this.callCounts.get(key);

    if (!entry || now - entry.windowStart > hourMs) {
      // New window
      this.callCounts.set(key, { count: 1, windowStart: now });
      return null;
    }

    if (entry.count >= manifest.max_calls_per_hour) {
      const remainingMs = hourMs - (now - entry.windowStart);
      const remainingMin = Math.ceil(remainingMs / 60_000);
      return `Rate limit exceeded for ${manifest.name}: ${manifest.max_calls_per_hour} calls/hour. Try again in ~${remainingMin} minutes.`;
    }

    entry.count++;
    return null;
  }

  private validateOutput(output: string, manifest: ToolManifest): string | null {
    if (!manifest.output_schema) return null;

    try {
      // Strip the untrusted data wrapper to get raw output
      const rawOutput = output
        .replace("[TOOL OUTPUT — UNTRUSTED EXTERNAL DATA]\n", "")
        .replace("\n[END TOOL OUTPUT]", "");

      const parsed = JSON.parse(rawOutput);

      // Basic type check
      if (manifest.output_schema.type === "object" && (typeof parsed !== "object" || parsed === null)) {
        return `Tool ${manifest.name} returned non-object output when object was expected`;
      }

      // Check for required fields if specified
      const required = manifest.output_schema.required;
      if (Array.isArray(required)) {
        for (const field of required) {
          if (typeof field === "string" && !(field in parsed)) {
            return `Tool ${manifest.name} output missing required field: ${field}`;
          }
        }
      }

      return null;
    } catch {
      // If output isn't valid JSON, that might be fine for some tools
      if (manifest.output_schema.type === "object") {
        return `Tool ${manifest.name} returned non-JSON output when JSON object was expected`;
      }
      return null;
    }
  }

  async execute(
    manifest: ToolManifest,
    args: Record<string, unknown>,
    envOverrides?: Record<string, string>,
    context?: ToolExecutionContext,
  ): Promise<string> {
    const tag = context?.agentId ? { agent_id: context.agentId } : {};

    // Rate limit check
    const rateLimitError = this.checkRateLimit(manifest);
    if (rateLimitError) {
      this.logger?.emit("agent.tool.rate_limited", {
        ...tag,
        tool_name: manifest.name,
        max_calls_per_hour: manifest.max_calls_per_hour,
      });
      throw new Error(rateLimitError);
    }

    const handlerPath = path.join(
      this.toolsDir,
      manifest.name.replace(/_/g, "-"),
      manifest.handler,
    );

    const runtimeMap: Record<string, string> = {
      python: "python3",
      node: "node",
    };
    const runtime = runtimeMap[manifest.runtime] ?? manifest.runtime;

    // Build minimal env: only declared secrets + PATH
    // envOverrides maps logical env var names to actual env var names,
    // allowing per-agent credential isolation.
    const env: Record<string, string> = {};
    if (process.env.PATH) {
      env.PATH = process.env.PATH;
    }
    if (context?.personaDir) {
      // Trusted runtime context. This path comes from operator configuration,
      // never from model-supplied tool arguments.
      env.NEWSTEAM_PERSONA_DIR = path.resolve(context.personaDir);
    }
    for (const secret of manifest.secrets) {
      const actualName = envOverrides?.[secret] ?? secret;
      const value = process.env[actualName];
      if (value !== undefined) {
        env[secret] = value;
      }
    }

    const startTime = Date.now();

    try {
      const result = await this.executeChild(runtime, handlerPath, manifest, args, env);

      // Validate output schema
      const validationError = this.validateOutput(result, manifest);
      if (validationError) {
        this.logger?.emit("agent.tool.output_invalid", {
          ...tag,
          tool_name: manifest.name,
          error: validationError,
        });
        console.warn(`[executor] ${validationError}`);
        // Log but don't reject — the output might still be useful
      }

      // Strip the wrapper to get raw output for logging
      const rawOutput = result
        .replace("[TOOL OUTPUT — UNTRUSTED EXTERNAL DATA]\n", "")
        .replace("\n[END TOOL OUTPUT]", "");

      this.logger?.emit("agent.tool.execute", {
        ...tag,
        tool_name: manifest.name,
        args,
        duration_ms: Date.now() - startTime,
        output: rawOutput.slice(0, 1000),
      });
      return result;
    } catch (err) {
      this.logger?.emit("agent.tool.error", {
        ...tag,
        tool_name: manifest.name,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  private executeChild(
    runtime: string,
    handlerPath: string,
    manifest: ToolManifest,
    args: Record<string, unknown>,
    env: Record<string, string>,
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const child = spawn(runtime, [handlerPath], {
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (data: Buffer) => {
        stdout += data.toString();
      });

      child.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(
          new Error(
            `Tool ${manifest.name} timed out after ${manifest.timeout_ms}ms`,
          ),
        );
      }, manifest.timeout_ms);

      child.on("close", (code) => {
        clearTimeout(timer);

        // Redact secrets from both stdout and stderr before returning
        const safeStdout = redactSecrets(stdout, manifest.secrets, env);
        const safeStderr = redactSecrets(stderr, manifest.secrets, env);

        if (code !== 0) {
          reject(
            new Error(
              `Tool ${manifest.name} failed with exit code ${code}: ${safeStderr.slice(0, 500)}`,
            ),
          );
          return;
        }

        // Cap output size to prevent context domination
        const MAX_TOOL_OUTPUT_CHARS = 8000;
        const trimmedOutput = safeStdout.length > MAX_TOOL_OUTPUT_CHARS
          ? safeStdout.slice(0, MAX_TOOL_OUTPUT_CHARS) + "\n... (output truncated)"
          : safeStdout;

        // Wrap output to signal untrusted content to the model
        resolve(`[TOOL OUTPUT — UNTRUSTED EXTERNAL DATA]\n${trimmedOutput}\n[END TOOL OUTPUT]`);
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        reject(
          new Error(`Tool ${manifest.name} failed to start: ${err.message}`),
        );
      });

      // Send args as JSON on stdin
      child.stdin.write(JSON.stringify(args));
      child.stdin.end();
    });
  }
}
