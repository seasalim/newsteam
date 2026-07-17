import { EventEmitter } from "node:events";
import { createInterface } from "node:readline/promises";

export class TerminalPromptCancelledError extends Error {
  constructor() {
    super("Setup cancelled.");
    this.name = "TerminalPromptCancelledError";
  }
}

export interface SecretInput extends EventEmitter {
  isRaw?: boolean;
  isPaused(): boolean;
  pause(): this;
  resume(): this;
  setEncoding(encoding: BufferEncoding): this;
  setRawMode?(mode: boolean): this;
}

export interface PromptOutput {
  write(value: string): unknown;
}

export interface TerminalPrompter {
  readonly interactive: boolean;
  write(message: string): void;
  question(prompt: string): Promise<string>;
  secret(prompt: string): Promise<string>;
}

export async function readHiddenLine(
  prompt: string,
  input: SecretInput = process.stdin,
  output: PromptOutput = process.stdout,
): Promise<string> {
  if (!input.setRawMode) {
    throw new Error("Hidden input requires an interactive terminal");
  }

  const wasPaused = input.isPaused();
  const wasRaw = input.isRaw ?? false;
  let value = "";

  output.write(prompt);
  input.setEncoding("utf8");
  input.setRawMode(true);
  input.resume();

  return new Promise<string>((resolve, reject) => {
    let settled = false;

    const cleanup = (): void => {
      input.off("data", onData);
      input.off("error", onError);
      input.setRawMode?.(wasRaw);
      if (wasPaused) input.pause();
    };

    const finish = (result?: string, error?: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      output.write("\n");
      if (error) reject(error);
      else resolve(result ?? "");
    };

    const onError = (error: Error): void => finish(undefined, error);
    const onData = (chunk: string | Buffer): void => {
      for (const character of String(chunk)) {
        if (character === "\u0003" || character === "\u0004") {
          finish(undefined, new TerminalPromptCancelledError());
          return;
        }
        if (character === "\r" || character === "\n") {
          finish(value);
          return;
        }
        if (character === "\u007f" || character === "\b") {
          const characters = [...value];
          if (characters.length > 0) {
            characters.pop();
            value = characters.join("");
            output.write("\b \b");
          }
          continue;
        }
        if (/^[\u0020-\u007E]$/u.test(character)) {
          value += character;
          output.write("•");
        }
      }
    };

    input.on("data", onData);
    input.on("error", onError);
  });
}

export function createTerminalPrompter(): TerminalPrompter {
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  return {
    interactive,
    write(message: string): void {
      process.stdout.write(`${message}\n`);
    },
    async question(prompt: string): Promise<string> {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      let cancelled = false;
      rl.on("SIGINT", () => {
        cancelled = true;
        rl.close();
      });
      try {
        return await rl.question(prompt);
      } catch (error) {
        if (cancelled) throw new TerminalPromptCancelledError();
        throw error;
      } finally {
        rl.close();
      }
    },
    secret(prompt: string): Promise<string> {
      return readHiddenLine(prompt);
    },
  };
}
