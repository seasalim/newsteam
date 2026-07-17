import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { DEFAULT_PERSONA_ID } from "./onboarding.ts";

export interface DemoWorkspace {
  rootDir: string;
  personaDir: string;
  cleanup(): void;
}

export interface DemoWorkspaceOptions {
  personaId?: string;
  tempParent?: string;
}

export function createDemoWorkspace(
  projectRoot = process.cwd(),
  options: DemoWorkspaceOptions = {},
): DemoWorkspace {
  const personaId = options.personaId ?? DEFAULT_PERSONA_ID;
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(personaId)) {
    throw new Error(`Invalid demo persona ID: ${personaId}`);
  }

  const tempParent = options.tempParent ?? tmpdir();
  const rootDir = mkdtempSync(path.join(tempParent, "newsteam-demo-"));
  const personaDir = path.join(rootDir, personaId);
  try {
    cpSync(path.join(projectRoot, "examples", "personas", personaId), personaDir, {
      recursive: true,
    });
  } catch (error) {
    rmSync(rootDir, { recursive: true, force: true });
    throw error;
  }

  return {
    rootDir,
    personaDir,
    cleanup: () => rmSync(rootDir, { recursive: true, force: true }),
  };
}

export function formatDemoError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/GOOGLE_API_KEY is required/u.test(message)) {
    return message;
  }

  if (/PerDay|requests?\s+per\s+day|daily\s+(?:request|quota|limit)/iu.test(message)) {
    const limit = message.match(/limit["'\s:]+(\d+)/iu)?.[1];
    return `Gemini's daily${limit ? ` ${limit}-request` : ""} limit was reached. It resets at midnight Pacific Time. API keys from the same Google Cloud project share this quota. Check usage at https://ai.dev/rate-limit.`;
  }

  if (/PerMinute|requests?\s+per\s+minute|tokens?\s+per\s+minute/iu.test(message)) {
    return "Gemini's short-term rate limit was reached. Wait a minute, then run the demo again.";
  }

  if (/429|RESOURCE_EXHAUSTED|rate limit/iu.test(message)) {
    return "Gemini reached a rate or quota limit. Check the reset time at https://ai.dev/rate-limit, then run the demo again.";
  }
  if (/API.?key|PERMISSION_DENIED|401|403/iu.test(message)) {
    return "Google rejected the API key. Check GOOGLE_API_KEY in .env, or restart the demo and enter a different key.";
  }
  return message;
}
