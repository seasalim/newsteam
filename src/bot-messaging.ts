/**
 * Discord message helpers: length limits, chunked sending, and
 * attachment preparation.
 *
 * Extracted from bot.ts to keep files under 500 lines.
 */

import path from "node:path";
import { execFile } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

export const DISCORD_LIMIT = 2000;

export type SendOptions = {
  content: string;
  allowedMentions?: { parse: string[] };
};

export type SendableChannel = {
  send: (content: string | SendOptions) => Promise<ReactableMessage>;
};

export type ReactableMessage = {
  react: (emoji: string) => Promise<unknown>;
  awaitReactions: (options: {
    filter: (reaction: { emoji: { name: string | null } }, user: { id: string }) => boolean;
    max: number;
    time: number;
  }) => Promise<Map<string, { emoji: { name: string | null } }>>;
};

/** Truncate any string to fit Discord's 2000-char limit */
export function safeTruncate(text: string): string {
  if (text.length <= DISCORD_LIMIT) {
    return text;
  }
  return text.slice(0, DISCORD_LIMIT - 16) + "... (truncated)";
}

/** Split a long message into chunks that each fit Discord's 2000-char limit.
 *  Splits on paragraph breaks (double newline) first, then single newlines. */
export function splitMessage(text: string, limit: number = DISCORD_LIMIT): string[] {
  if (text.length <= limit) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }

    // Find the best break point within the limit
    let breakAt = -1;

    // Prefer paragraph break (double newline)
    const paraBreak = remaining.lastIndexOf("\n\n", limit);
    if (paraBreak > 0) {
      breakAt = paraBreak;
    } else {
      // Fall back to single newline
      const lineBreak = remaining.lastIndexOf("\n", limit);
      if (lineBreak > 0) {
        breakAt = lineBreak;
      } else {
        // Last resort: break at limit
        breakAt = limit;
      }
    }

    chunks.push(remaining.slice(0, breakAt).trimEnd());
    remaining = remaining.slice(breakAt).trimStart();
  }

  return chunks;
}

export function isSendableChannel(channel: unknown): channel is SendableChannel {
  return (
    typeof channel === "object" &&
    channel !== null &&
    "send" in channel &&
    typeof (channel as { send?: unknown }).send === "function"
  );
}

/** Send to Discord with splitting and error swallowing */
export async function safeSend(
  channel: { send: (content: string) => Promise<unknown> },
  text: string,
): Promise<void> {
  try {
    const chunks = splitMessage(text);
    for (const chunk of chunks) {
      await channel.send(chunk);
    }
  } catch (err) {
    console.error("[bot] Failed to send to Discord:", err);
  }
}

export type PreparedAttachment = {
  attachment: string;
  name: string;
  cleanup?: () => Promise<void>;
};

function execFileAsync(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

export async function prepareAttachmentForDiscord(filePath: string, fileName?: string): Promise<PreparedAttachment> {
  const name = fileName ?? path.basename(filePath);
  if (!filePath.toLowerCase().endsWith(".svg") || process.platform !== "darwin") {
    return { attachment: filePath, name };
  }

  try {
    await access(filePath);
  } catch {
    return { attachment: filePath, name };
  }

  const outputDir = await mkdtemp(path.join(tmpdir(), "newsteam-discord-preview-"));
  const pngPath = path.join(outputDir, `${path.basename(filePath, ".svg")}.png`);
  const cleanup = async () => rm(outputDir, { recursive: true, force: true });

  try {
    await execFileAsync("sips", ["-s", "format", "png", filePath, "--out", pngPath]);
    await access(pngPath);
    return {
      attachment: pngPath,
      name: name.replace(/\.svg$/iu, ".png"),
      cleanup,
    };
  } catch (error) {
    await cleanup();
    console.warn(`[bot] Failed to rasterize SVG attachment ${filePath}:`, error);
    return { attachment: filePath, name };
  }
}
