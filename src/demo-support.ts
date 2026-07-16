import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { FeedItem } from "./feeds.ts";

const DEMO_AGENT_ID = "kingclawd";

export interface DemoWorkspace {
  rootDir: string;
  personaDir: string;
  cleanup(): void;
}

export function createDemoWorkspace(
  projectRoot = process.cwd(),
  tempParent = tmpdir(),
): DemoWorkspace {
  const rootDir = mkdtempSync(path.join(tempParent, "newsteam-demo-"));
  const personaDir = path.join(rootDir, DEMO_AGENT_ID);
  try {
    cpSync(path.join(projectRoot, "examples", "personas", DEMO_AGENT_ID), personaDir, {
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

export function loadDemoFallbackItems(projectRoot = process.cwd()): FeedItem[] {
  const filePath = path.join(projectRoot, "examples", "demo-items.json");
  const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
  return Array.isArray(parsed) ? parsed as FeedItem[] : [];
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
    return "Google rejected the API key. Check GOOGLE_API_KEY in .env and try again.";
  }
  return message;
}
