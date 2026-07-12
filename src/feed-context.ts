/**
 * Feed context management: rolling digest context, digest archive,
 * and persona text file loading (interests, lens).
 */

import fs from "node:fs";
import path from "node:path";

const MAX_FEED_CONTEXT_ENTRIES = 8;
const MAX_DIGEST_ARCHIVE_ENTRIES = 60; // ~3 digests/day × 20 days

// ── Types ────────────────────────────────────────────────────────

export type FeedContextEntry = {
  timestamp: string;
  topics: string[];
  entities: string[];
  sentiment: string;
  summary: string;
  interests_served?: string[];
};

export type DigestArchiveEntry = {
  timestamp: string;
  digest_text: string;
  context: FeedContextEntry;
  items_offered: number;
  feed_ids: string[];
};

// ── Feed context (rolling digest memory) ─────────────────────────

export function loadFeedContext(contextPath: string): FeedContextEntry[] {
  try {
    const raw = fs.readFileSync(contextPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as FeedContextEntry[];
  } catch {
    return [];
  }
}

export function saveFeedContext(contextPath: string, entries: FeedContextEntry[]): void {
  const trimmed = entries.slice(-MAX_FEED_CONTEXT_ENTRIES);
  const dir = path.dirname(contextPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = contextPath + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(trimmed, null, 2), "utf-8");
  fs.renameSync(tmpPath, contextPath);
}

export function buildContextSection(entries: FeedContextEntry[]): string {
  if (entries.length === 0) return "";

  const lines = [
    "## Recent digest context",
    "Here's what you covered in your recent digests. Use this to spot recurring themes, track developing stories, and avoid repeating yourself:",
    "",
  ];

  for (const entry of entries.slice(-5)) {
    const date = entry.timestamp.slice(0, 10);
    lines.push(`**${date}**: ${entry.summary}`);
    if (entry.topics.length > 0) {
      lines.push(`  Topics: ${entry.topics.join(", ")}`);
    }
    if (entry.entities.length > 0) {
      lines.push(`  Entities: ${entry.entities.join(", ")}`);
    }
    if (entry.sentiment) {
      lines.push(`  Sentiment: ${entry.sentiment}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ── Digest archive (rolling history for weekly synthesis) ────────

export function loadDigestArchive(archivePath: string): DigestArchiveEntry[] {
  try {
    const raw = fs.readFileSync(archivePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as DigestArchiveEntry[];
  } catch {
    return [];
  }
}

export function saveDigestArchive(archivePath: string, entries: DigestArchiveEntry[]): void {
  const trimmed = entries.slice(-MAX_DIGEST_ARCHIVE_ENTRIES);
  const dir = path.dirname(archivePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = archivePath + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(trimmed, null, 2), "utf-8");
  fs.renameSync(tmpPath, archivePath);
}

export function appendDigestArchive(
  archivePath: string,
  entry: DigestArchiveEntry,
): void {
  const existing = loadDigestArchive(archivePath);
  existing.push(entry);
  saveDigestArchive(archivePath, existing);
}

// ── Text file loading (interests, lens) ─────────────────────────

export function loadTextFile(filePath: string): string {
  try {
    const raw = fs.readFileSync(filePath, "utf-8").trim();
    return raw.length > 0 ? raw : "";
  } catch {
    return "";
  }
}

export const loadInterests = loadTextFile;
export const loadLens = loadTextFile;

export function buildInterestsSection(interests: string): string {
  if (!interests) return "";

  return [
    "## Your interests & domain priorities",
    "Use these to decide what's worth your attention. Items that align with high-weight interests deserve deeper analysis (fetch the article). Items outside your interests can be briefly mentioned or skipped.",
    "",
    interests,
    "",
  ].join("\n");
}

export function buildLensSection(lens: string): string {
  if (!lens) return "";

  return [
    "## Your analytical lens",
    lens,
    "",
  ].join("\n");
}
