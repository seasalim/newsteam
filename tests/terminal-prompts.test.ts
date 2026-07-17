import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  readHiddenLine,
  TerminalPromptCancelledError,
  type PromptOutput,
  type SecretInput,
} from "../src/terminal-prompts.ts";

class FakeSecretInput extends EventEmitter implements SecretInput {
  isRaw = false;
  paused = true;

  isPaused(): boolean {
    return this.paused;
  }

  pause(): this {
    this.paused = true;
    return this;
  }

  resume(): this {
    this.paused = false;
    return this;
  }

  setEncoding(_encoding: BufferEncoding): this {
    return this;
  }

  setRawMode(mode: boolean): this {
    this.isRaw = mode;
    return this;
  }
}

function createOutput(): PromptOutput & { content: string } {
  return {
    content: "",
    write(value: string): void {
      this.content += value;
    },
  };
}

test("readHiddenLine masks input, handles backspace, and restores terminal state", async () => {
  const input = new FakeSecretInput();
  const output = createOutput();
  const resultPromise = readHiddenLine("API key: ", input, output);

  input.emit("data", "abc\u007fd\r");
  const result = await resultPromise;

  assert.equal(result, "abd");
  assert.equal(output.content.includes("abc"), false);
  assert.equal(output.content, "API key: •••\b \b•\n");
  assert.equal(input.isRaw, false);
  assert.equal(input.paused, true);
});

test("readHiddenLine rejects Ctrl-C and restores terminal state", async () => {
  const input = new FakeSecretInput();
  const output = createOutput();
  const resultPromise = readHiddenLine("API key: ", input, output);

  input.emit("data", "secret\u0003");

  await assert.rejects(resultPromise, TerminalPromptCancelledError);
  assert.equal(output.content.includes("secret"), false);
  assert.equal(input.isRaw, false);
  assert.equal(input.paused, true);
});
