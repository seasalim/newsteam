import fs from "node:fs";
import path from "node:path";

export type LocalMessageRole = "user" | "agent" | "system";
export type LocalMessageKind =
  | "chat"
  | "digest"
  | "synthesis"
  | "command"
  | "confirmation"
  | "error";

export interface LocalMessage {
  id: string;
  channel_id: string;
  role: LocalMessageRole;
  kind: LocalMessageKind;
  text: string;
  ts: string;
}

export interface TranscriptChannel {
  channelId: string;
  personaDir: string;
}

const COMPACT_THRESHOLD = 5_000;
const COMPACT_KEEP = 2_000;

function parseMessages(lines: string[]): LocalMessage[] {
  const messages: LocalMessage[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as LocalMessage;
      if (
        typeof parsed.id === "string" &&
        typeof parsed.channel_id === "string" &&
        typeof parsed.text === "string" &&
        typeof parsed.ts === "string"
      ) {
        messages.push(parsed);
      }
    } catch {
      // A partial final write or hand-edited bad line should not hide valid history.
    }
  }
  return messages;
}

export class LocalTranscript {
  private readonly paths = new Map<string, string>();

  constructor(channels: TranscriptChannel[]) {
    for (const channel of channels) {
      const fileName = `${encodeURIComponent(channel.channelId)}.jsonl`;
      this.paths.set(
        channel.channelId,
        path.join(channel.personaDir, "local_channel", fileName),
      );
    }
  }

  initialize(): void {
    for (const filePath of this.paths.values()) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      if (!fs.existsSync(filePath)) continue;
      const lines = fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean);
      if (lines.length <= COMPACT_THRESHOLD) continue;
      const retained = lines.slice(-COMPACT_KEEP);
      fs.writeFileSync(filePath, `${retained.join("\n")}\n`, "utf8");
    }
  }

  append(message: LocalMessage): void {
    const filePath = this.requirePath(message.channel_id);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify(message)}\n`, "utf8");
  }

  history(
    channelId: string,
    options: { before?: string; after?: string; n?: number } = {},
  ): LocalMessage[] {
    const messages = this.read(channelId);
    const limit = Math.max(1, Math.min(options.n ?? 100, 200));

    if (options.after) {
      return messages.filter((message) => message.id > options.after!).slice(0, limit);
    }

    const eligible = options.before
      ? messages.filter((message) => message.id < options.before!)
      : messages;
    return eligible.slice(-limit);
  }

  allAfter(messageId: string, limit = 1_000): LocalMessage[] {
    const messages: LocalMessage[] = [];
    for (const channelId of this.paths.keys()) {
      messages.push(...this.read(channelId).filter((message) => message.id > messageId));
    }
    return messages.sort((a, b) => a.id.localeCompare(b.id)).slice(0, limit);
  }

  private read(channelId: string): LocalMessage[] {
    const filePath = this.requirePath(channelId);
    try {
      return parseMessages(fs.readFileSync(filePath, "utf8").split("\n"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private requirePath(channelId: string): string {
    const filePath = this.paths.get(channelId);
    if (!filePath) throw new Error(`Unknown local channel: ${channelId}`);
    return filePath;
  }
}
