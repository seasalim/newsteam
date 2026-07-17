import assert from "node:assert/strict";
import test from "node:test";

import { collectDemoSetup } from "../src/demo-setup.ts";
import type { TerminalPrompter } from "../src/terminal-prompts.ts";

function createFakePrompter(options: {
  interactive: boolean;
  questions?: string[];
  secrets?: string[];
}): TerminalPrompter & {
  messages: string[];
  questionPrompts: string[];
  secretPrompts: string[];
} {
  const questions = [...(options.questions ?? [])];
  const secrets = [...(options.secrets ?? [])];
  const messages: string[] = [];
  const questionPrompts: string[] = [];
  const secretPrompts: string[] = [];

  return {
    interactive: options.interactive,
    messages,
    questionPrompts,
    secretPrompts,
    write(message: string): void {
      messages.push(message);
    },
    async question(prompt: string): Promise<string> {
      questionPrompts.push(prompt);
      return questions.shift() ?? "";
    },
    async secret(prompt: string): Promise<string> {
      secretPrompts.push(prompt);
      return secrets.shift() ?? "";
    },
  };
}

test("collectDemoSetup uses a configured key and prompts only for persona", async () => {
  const prompter = createFakePrompter({ interactive: true, questions: ["the-analyst"] });
  const setup = await collectDemoSetup(process.cwd(), {
    env: { GOOGLE_API_KEY: " configured-key " },
    prompter,
  });

  assert.equal(setup.apiKey, "configured-key");
  assert.equal(setup.persona.id, "the-analyst");
  assert.equal(prompter.secretPrompts.length, 0);
  assert.ok(prompter.messages.some((message) => message.includes("configured via GOOGLE_API_KEY")));
});

test("collectDemoSetup securely prompts until a missing key is configured", async () => {
  const prompter = createFakePrompter({
    interactive: true,
    questions: [""],
    secrets: ["", " entered-key "],
  });
  const setup = await collectDemoSetup(process.cwd(), { env: {}, prompter });

  assert.equal(setup.apiKey, "entered-key");
  assert.equal(setup.persona.id, "kingclawd");
  assert.equal(prompter.secretPrompts.length, 2);
  assert.equal(prompter.messages.join("\n").includes("entered-key"), false);
  assert.ok(prompter.messages.some((message) => message.includes("this run only")));
});

test("collectDemoSetup never prompts in non-interactive mode", async () => {
  const prompter = createFakePrompter({ interactive: false });

  await assert.rejects(
    collectDemoSetup(process.cwd(), { env: {}, prompter }),
    /GOOGLE_API_KEY is required for non-interactive use/u,
  );
  assert.equal(prompter.questionPrompts.length, 0);
  assert.equal(prompter.secretPrompts.length, 0);
});

test("collectDemoSetup honors a non-interactive persona override", async () => {
  const prompter = createFakePrompter({ interactive: false });
  const setup = await collectDemoSetup(process.cwd(), {
    env: {
      GOOGLE_API_KEY: "configured-key",
      NEWSTEAM_DEMO_PERSONA: "the-general",
    },
    prompter,
  });

  assert.equal(setup.persona.id, "the-general");
  assert.equal(prompter.questionPrompts.length, 0);
});

test("collectDemoSetup rejects an unknown persona override", async () => {
  const prompter = createFakePrompter({ interactive: false });

  await assert.rejects(
    collectDemoSetup(process.cwd(), {
      env: {
        GOOGLE_API_KEY: "configured-key",
        NEWSTEAM_DEMO_PERSONA: "unknown",
      },
      prompter,
    }),
    /Available personas:.*kingclawd/u,
  );
});
