import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const DEFAULT_CATEGORY = "general";

const VALID_CATEGORIES = new Set([
  "preference",
  "fact",
  "relationship",
  "decision",
  "general",
]);

interface CategorizedEntry {
  text: string;
  category: string;
}

function normalizeEntry(text: string): string {
  return text.replace(/\r?\n/g, " ").trim();
}

function lineToEntry(line: string): string {
  return line.startsWith("- ") ? line.slice(2) : line;
}

/**
 * Parse a MEMORY.md file that may use the new category-section format
 * (## category headers) or the old flat-list format (just `- entry` lines).
 */
function parseCategorizedContent(content: string): CategorizedEntry[] {
  const entries: CategorizedEntry[] = [];
  let currentCategory = DEFAULT_CATEGORY;
  let hasHeaders = false;

  for (const line of content.split(/\r?\n/u)) {
    const trimmed = line.trim();

    if (trimmed.length === 0) {
      continue;
    }

    // Detect category header: ## category
    if (trimmed.startsWith("## ")) {
      const header = trimmed.slice(3).trim().toLowerCase();
      currentCategory = header;
      hasHeaders = true;
      continue;
    }

    // Detect bullet entry
    if (trimmed.startsWith("- ")) {
      entries.push({
        text: lineToEntry(trimmed),
        category: hasHeaders ? currentCategory : DEFAULT_CATEGORY,
      });
    }
  }

  return entries;
}

/**
 * Serialize categorized entries into the category-section format.
 */
function serializeCategorized(entries: CategorizedEntry[]): string {
  // Group by category, preserving insertion order per category
  const groups = new Map<string, string[]>();

  for (const entry of entries) {
    const cat = entry.category;

    if (!groups.has(cat)) {
      groups.set(cat, []);
    }

    groups.get(cat)!.push(entry.text);
  }

  const sections: string[] = [];

  for (const [category, items] of groups) {
    sections.push(`## ${category}`);

    for (const item of items) {
      sections.push(`- ${item}`);
    }
  }

  return sections.join("\n");
}

export class MemoryManager {
  private readonly memoryFilePath: string;

  private readonly maxTokens: number;

  private readonly queue: CategorizedEntry[] = [];

  constructor(memoryFilePath: string, maxTokens: number) {
    this.memoryFilePath = memoryFilePath;
    this.maxTokens = maxTokens;
  }

  load(): string {
    if (!existsSync(this.memoryFilePath)) {
      return "";
    }

    return readFileSync(this.memoryFilePath, "utf8");
  }

  remember(text: string, category?: string): void {
    const normalizedEntry = normalizeEntry(text);

    if (normalizedEntry.length === 0) {
      return;
    }

    const resolvedCategory =
      category && VALID_CATEGORIES.has(category) ? category : DEFAULT_CATEGORY;

    this.queue.push({ text: normalizedEntry, category: resolvedCategory });
  }

  flush(): void {
    if (this.queue.length === 0) {
      return;
    }

    const parentDirectory = path.dirname(this.memoryFilePath);
    mkdirSync(parentDirectory, { recursive: true });

    const content = this.load();
    const existingEntries = parseCategorizedContent(content);

    const combinedEntries = existingEntries.concat(this.queue);
    const trimmedEntries = this.trimToFit(combinedEntries);
    const serializedMemory = serializeCategorized(trimmedEntries);

    writeFileSync(this.memoryFilePath, serializedMemory, "utf8");
    this.queue.length = 0;
  }

  clear(): void {
    const parentDirectory = path.dirname(this.memoryFilePath);
    mkdirSync(parentDirectory, { recursive: true });
    writeFileSync(this.memoryFilePath, "", "utf8");
    this.queue.length = 0;
  }

  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  getQueueSize(): number {
    return this.queue.length;
  }

  /** Search memory entries by keyword match (case-insensitive). */
  search(query: string): string[] {
    const content = this.load();

    if (content.length === 0) {
      return [];
    }

    const entries = parseCategorizedContent(content);
    const lowerQuery = query.toLowerCase();

    return entries
      .filter((entry) => entry.text.toLowerCase().includes(lowerQuery))
      .map((entry) => entry.text);
  }

  /** Discard pending entries (e.g. on failed turn) without writing to disk */
  discardPending(): void {
    this.queue.length = 0;
  }

  private trimToFit(entries: CategorizedEntry[]): CategorizedEntry[] {
    const normalized = entries.map((entry) => ({
      ...entry,
      text: this.truncateEntryToFit(entry.text),
    }));

    while (
      normalized.length > 1 &&
      this.estimateTokens(serializeCategorized(normalized)) > this.maxTokens
    ) {
      normalized.shift();
    }

    if (
      normalized.length === 1 &&
      this.estimateTokens(serializeCategorized(normalized)) > this.maxTokens
    ) {
      return [{ ...normalized[0], text: this.truncateEntryToFit(normalized[0].text) }];
    }

    return normalized;
  }

  private truncateEntryToFit(entry: string): string {
    const maxChars = this.maxTokens * 4;
    const prefix = "- ";
    const suffix = "...";
    const serializedEntry = `${prefix}${entry}`;

    if (this.estimateTokens(serializedEntry) <= this.maxTokens) {
      return entry;
    }

    const availableChars = maxChars - prefix.length - suffix.length;

    if (availableChars <= 0) {
      return suffix;
    }

    return `${entry.slice(0, availableChars)}${suffix}`;
  }
}
