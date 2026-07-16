/**
 * Core feed pipeline: shared types, utility functions, pending items,
 * time helpers, feed registry, and the feed-check script runner.
 *
 * Sub-modules (all re-exported here for backward compatibility):
 * - feed-context.ts  — rolling digest context, archive, interests/lens
 * - feed-digest.ts   — digest prompt building, selection, job orchestration
 * - feed-monitor.ts  — scheduled monitoring, delivery, manual refresh
 * - feed-review.ts   — per-feed source quality review
 * - feed-synthesis.ts — weekly synthesis
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// ── Re-exports for backward compatibility ────────────────────────
// Consumers import everything from "./feeds.js" — keep that working.

export type { DigestQualityEvaluation } from "./agent.ts";
export {
  type FeedContextEntry,
  type DigestArchiveEntry,
  appendDigestArchive,
  buildContextSection,
  buildInterestsSection,
  buildLensSection,
  loadDigestArchive,
  loadFeedContext,
  loadInterests,
  loadLens,
  saveDigestArchive,
  saveFeedContext,
} from "./feed-context.ts";
export {
  type DigestMetrics,
  buildFeedDigestPrompt,
  enqueueFeedDigestJob,
  selectDigestItems,
} from "./feed-digest.ts";
export {
  runDigestDelivery,
  runFeedMonitorCycle,
  runFeedRefresh,
} from "./feed-monitor.ts";
export {
  type SynthesisMetrics,
  buildWeeklySynthesisPrompt,
  compactDigestSummaries,
  isSynthesisTime,
  runWeeklySynthesis,
} from "./feed-synthesis.ts";

// ── Constants ────────────────────────────────────────────────────

const FEED_CHECK_TIMEOUT_MS = 30_000;
const FEED_CHECK_MAX_BUFFER = 1024 * 1024;
export const PACIFIC_TIME_ZONE = "America/Los_Angeles";
const DEFAULT_FEEDS_REGISTRY_PATH = path.resolve("persona", "feeds.json");
export const DEFAULT_MAX_QUEUE_AGE_HOURS = 8;
export const DEFAULT_PENDING_MAX_AGE_HOURS = DEFAULT_MAX_QUEUE_AGE_HOURS;

// ── Types ────────────────────────────────────────────────────────

export type FeedItem = {
  feed_id?: string;
  feed_name?: string;
  title?: string;
  url?: string;
  snippet?: string | null;
  published?: string;
  queued_at?: string;
};

export type FeedFetchHint = "auto" | "always" | "never";
export type FeedContentQuality = "unknown" | "thin-snippet" | "partial" | "full-text";

export type FeedRegistryMetadata = {
  id: string;
  name: string;
  fetchHint: FeedFetchHint;
  contentQuality: FeedContentQuality;
  maxQueueAgeHours?: number;
  maxContentAgeHours?: number;
};

export type PendingRetentionOptions = {
  feedsPath?: string;
  maxQueueAgeHours?: number;
  maxContentAgeHours?: number;
  nowMs?: number;
};

export type FeedCheckResult = {
  new_items?: FeedItem[];
  feeds_checked?: number;
  feeds_skipped?: number;
  errors?: Array<{ feed_id: string; error: string }>;
};

type FeedLogger = Pick<Console, "log" | "error">;

type ExecFileRunner = (params: {
  file: string;
  args: string[];
  input: string;
  timeoutMs: number;
}) => Promise<{ stdout: string; stderr: string }>;

// ── Shared utility functions ─────────────────────────────────────
// Exported for use by feed-review.ts and feed-digest.ts

export function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const VALID_FETCH_HINTS = new Set<FeedFetchHint>(["auto", "always", "never"]);
const VALID_CONTENT_QUALITIES = new Set<FeedContentQuality>(["unknown", "thin-snippet", "partial", "full-text"]);
const TRACKING_PARAM_NAMES = new Set(["traffic_source"]);

export function normalizeFetchHint(value: unknown): FeedFetchHint {
  return typeof value === "string" && VALID_FETCH_HINTS.has(value as FeedFetchHint)
    ? value as FeedFetchHint
    : "auto";
}

export function normalizeContentQuality(value: unknown): FeedContentQuality {
  return typeof value === "string" && VALID_CONTENT_QUALITIES.has(value as FeedContentQuality)
    ? value as FeedContentQuality
    : "unknown";
}

export function sanitizeFeedText(value: string | undefined | null, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }

  const sanitized = value.replace(/[\x00-\x09\x0B-\x1F\x7F]/g, "").trim();
  return sanitized.length > 0 ? sanitized : fallback;
}

function parseOptionalPositiveInteger(value: unknown): number | undefined {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(num) || num <= 0) {
    return undefined;
  }
  return num;
}

export function normalizeComparableUrl(value: string | undefined): string {
  if (typeof value !== "string") return "";

  const trimmed = value.trim();
  if (trimmed.length === 0) return "";

  try {
    const url = new URL(trimmed);
    url.hash = "";
    const paramsToDelete: string[] = [];
    for (const key of url.searchParams.keys()) {
      const lowerKey = key.toLowerCase();
      if (lowerKey.startsWith("utm_") || lowerKey.startsWith("at_") || TRACKING_PARAM_NAMES.has(lowerKey)) {
        paramsToDelete.push(key);
      }
    }
    for (const key of paramsToDelete) {
      url.searchParams.delete(key);
    }
    let normalized = url.toString();
    if (normalized.endsWith("/")) {
      normalized = normalized.slice(0, -1);
    }
    return normalized;
  } catch {
    return trimmed.replace(/\/+$/u, "");
  }
}

// ── Feed registry metadata ───────────────────────────────────────

export function loadFeedRegistryMetadata(registryPath?: string): Map<string, FeedRegistryMetadata> {
  const filePath = registryPath ?? DEFAULT_FEEDS_REGISTRY_PATH;

  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Map();

    const metadata = new Map<string, FeedRegistryMetadata>();
    for (const entry of parsed) {
      if (!isObjectRecord(entry) || typeof entry.id !== "string" || entry.id.length === 0) {
        continue;
      }

      metadata.set(entry.id, {
        id: entry.id,
        name: typeof entry.name === "string" && entry.name.trim().length > 0 ? entry.name.trim() : entry.id,
        fetchHint: normalizeFetchHint(entry.fetch_hint),
        contentQuality: normalizeContentQuality(entry.content_quality),
        maxQueueAgeHours: parseOptionalPositiveInteger(entry.max_queue_age_hours),
        maxContentAgeHours: parseOptionalPositiveInteger(entry.max_content_age_hours),
      });
    }

    return metadata;
  } catch {
    return new Map();
  }
}

// ── Time helpers ─────────────────────────────────────────────────

export function isWithinWakingHours(
  hour: number,
  wakingHoursStart: number,
  wakingHoursEnd: number,
): boolean {
  if (wakingHoursStart <= wakingHoursEnd) {
    return hour >= wakingHoursStart && hour <= wakingHoursEnd;
  }

  return hour >= wakingHoursStart || hour <= wakingHoursEnd;
}

export function getCurrentPacificHour(date = new Date()): number {
  const formattedHour = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    hour12: false,
    timeZone: PACIFIC_TIME_ZONE,
  }).format(date);

  return Number.parseInt(formattedHour, 10);
}

export function isDigestTime(
  digestTimes: string[],
  getCurrentTime?: () => { hour: number; minute: number },
): boolean {
  const getTime = getCurrentTime ?? (() => {
    const pacificTime = new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "numeric",
      hour12: false,
      timeZone: PACIFIC_TIME_ZONE,
    }).format(new Date());
    const [hour, minute] = pacificTime.split(":").map(Number);
    return { hour, minute };
  });

  const { hour, minute } = getTime();
  const currentTimeStr = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  return digestTimes.includes(currentTimeStr);
}

// ── Pending items ────────────────────────────────────────────────

function getPendingPath(basePath?: string): string {
  return basePath ?? path.resolve("persona", "feeds_pending.json");
}

export function loadActiveFeedIds(feedsPath?: string): Set<string> {
  return new Set(loadFeedRegistryMetadata(feedsPath).keys());
}

export function filterToActiveFeeds(items: FeedItem[], activeFeedIds: Set<string>): FeedItem[] {
  if (activeFeedIds.size === 0) return items;
  return items.filter((item) => {
    const id = item.feed_id ?? "";
    return id === "" || activeFeedIds.has(id);
  });
}

function getPendingAgeMs(ageHours: number): number {
  return ageHours * 60 * 60 * 1000;
}

function getTimestampMs(value: string | undefined | null): number | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function normalizePendingRetentionOptions(
  options?: PendingRetentionOptions | number,
): PendingRetentionOptions {
  if (typeof options === "number") {
    return { maxQueueAgeHours: options };
  }
  return options ?? {};
}

function pruneStalePendingItems(
  items: FeedItem[],
  options?: PendingRetentionOptions | number,
): FeedItem[] {
  const normalized = normalizePendingRetentionOptions(options);
  const nowMs = normalized.nowMs ?? Date.now();
  const feedMetadata = normalized.feedsPath
    ? loadFeedRegistryMetadata(normalized.feedsPath)
    : new Map<string, FeedRegistryMetadata>();

  return items.filter((item) => {
    const metadata = item.feed_id ? feedMetadata.get(item.feed_id) : undefined;
    const maxQueueAgeHours = metadata?.maxQueueAgeHours
      ?? normalized.maxQueueAgeHours
      ?? DEFAULT_MAX_QUEUE_AGE_HOURS;
    const maxContentAgeHours = metadata?.maxContentAgeHours ?? normalized.maxContentAgeHours;

    const queueAnchorMs = getTimestampMs(item.queued_at) ?? getTimestampMs(item.published);
    if (queueAnchorMs !== null) {
      const queueCutoff = nowMs - getPendingAgeMs(maxQueueAgeHours);
      if (queueAnchorMs < queueCutoff) {
        return false;
      }
    }

    if (maxContentAgeHours !== undefined) {
      const publishedMs = getTimestampMs(item.published);
      if (publishedMs !== null) {
        const contentCutoff = nowMs - getPendingAgeMs(maxContentAgeHours);
        if (publishedMs < contentCutoff) {
          return false;
        }
      }
    }

    return true;
  });
}

export function loadPendingItems(
  pendingPath?: string,
  options?: PendingRetentionOptions | number,
): FeedItem[] {
  const filePath = getPendingPath(pendingPath);
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    const items = Array.isArray(parsed) ? parsed as FeedItem[] : [];
    const pruned = pruneStalePendingItems(items, options);
    if (pruned.length < items.length) {
      savePendingItems(pruned, pendingPath);
    }
    return pruned;
  } catch {
    return [];
  }
}

export function savePendingItems(items: FeedItem[], pendingPath?: string): void {
  const filePath = getPendingPath(pendingPath);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = filePath + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(items, null, 2), "utf-8");
  fs.renameSync(tmpPath, filePath);
}

export function clearPendingItems(pendingPath?: string): void {
  savePendingItems([], pendingPath);
}

function pendingItemKey(item: FeedItem): string {
  return `${item.url ?? ""}\0${item.title ?? ""}`;
}

export function appendPendingItems(
  newItems: FeedItem[],
  pendingPath?: string,
  options?: PendingRetentionOptions,
): void {
  const normalized = normalizePendingRetentionOptions(options);
  const nowIso = new Date(normalized.nowMs ?? Date.now()).toISOString();
  const activeFeedIds = loadActiveFeedIds(normalized.feedsPath);
  const existing = filterToActiveFeeds(loadPendingItems(pendingPath, normalized), activeFeedIds);
  const existingKeys = new Set(existing.map(pendingItemKey));
  const merged = [...existing];
  for (const item of filterToActiveFeeds(newItems, activeFeedIds)) {
    const key = pendingItemKey(item);
    if ((item.url || item.title) && !existingKeys.has(key)) {
      merged.push({
        ...item,
        queued_at: typeof item.queued_at === "string" && item.queued_at.length > 0
          ? item.queued_at
          : nowIso,
      });
      existingKeys.add(key);
    }
  }
  savePendingItems(merged, pendingPath);
}

// ── Feed check script ────────────────────────────────────────────

async function defaultExecFileRunner(params: {
  file: string;
  args: string[];
  input: string;
  timeoutMs: number;
}): Promise<{ stdout: string; stderr: string }> {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = execFile(
      params.file,
      params.args,
      {
        cwd: process.cwd(),
        timeout: params.timeoutMs,
        maxBuffer: FEED_CHECK_MAX_BUFFER,
      },
      (error, stdout, stderr) => {
        if (error) {
          const enrichedError = Object.assign(error, { stdout, stderr });
          reject(enrichedError);
          return;
        }

        resolve({ stdout, stderr });
      },
    );

    child.stdin?.end(params.input);
    child.stdin?.on("error", reject);
  });
}

export async function runFeedCheckScript(options: {
  scriptPath?: string;
  timeoutMs?: number;
  execFileRunner?: ExecFileRunner;
  log?: FeedLogger;
  action?: string;
  feedsPath?: string;
  statePath?: string;
} = {}): Promise<FeedCheckResult | null> {
  const scriptPath = options.scriptPath ?? path.resolve("scripts/feed-check.py");
  const timeoutMs = options.timeoutMs ?? FEED_CHECK_TIMEOUT_MS;
  const execFileRunner = options.execFileRunner ?? defaultExecFileRunner;
  const log = options.log ?? console;

  const payload: Record<string, string> = { action: options.action ?? "check" };
  if (options.feedsPath) payload.feeds_path = options.feedsPath;
  if (options.statePath) payload.state_path = options.statePath;

  try {
    const { stdout } = await execFileRunner({
      file: "python3",
      args: [scriptPath],
      input: JSON.stringify(payload),
      timeoutMs,
    });

    return JSON.parse(stdout) as FeedCheckResult;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error(`[feeds] feed-check.py failed: ${message}`);
    return null;
  }
}
