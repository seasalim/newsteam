import http from "node:http";

import type { ChannelAdapter, ChannelCallbacks } from "./channel.ts";
import { createChannelSessions, type SubmitResult } from "./channel-session.ts";
import type { HttpRouteHandler } from "./dashboard.ts";
import {
  LocalTranscript,
  type LocalMessage,
  type LocalMessageKind,
  type LocalMessageRole,
} from "./local-transcript.ts";
import { personaProfileUrl, servePersonaProfile } from "./persona-profile.ts";

export interface LocalChannelDefinition {
  channel_id: string;
  agent_id: string;
  is_feed_channel: boolean;
  persona_dir: string;
}

export interface LocalChannelConfig extends ChannelCallbacks {
  channels: LocalChannelDefinition[];
  rateLimitMs: number;
  pageHtml?: string;
}

export type LocalChannelAdapter = ChannelAdapter & {
  handleRequest: HttpRouteHandler;
};

interface PendingConfirmation {
  channelId: string;
  preview: string;
  expiresAt: string;
  timer: NodeJS.Timeout;
  resolve: (approved: boolean) => void;
}

let lastMessageMs = 0;
let messageSequence = 0;

function createMessageId(): string {
  const now = Math.max(Date.now(), lastMessageMs);
  if (now === lastMessageMs) messageSequence += 1;
  else {
    lastMessageMs = now;
    messageSequence = 0;
  }
  return `m_${now.toString(36).padStart(10, "0")}_${messageSequence.toString(36).padStart(4, "0")}`;
}

function jsonResponse(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 64 * 1024) throw new Error("Request body is too large");
    chunks.push(buffer);
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function confirmationId(): string {
  return `c_${createMessageId().slice(2)}`;
}

function isCrossOrigin(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (typeof origin !== "string") return false;
  try {
    return new URL(origin).host !== req.headers.host;
  } catch {
    return true;
  }
}

export function createLocalChannelAdapter(config: LocalChannelConfig): LocalChannelAdapter {
  const channelIds = new Set(config.channels.map((channel) => channel.channel_id));
  const profileSources = [
    ...new Map(config.channels.map((channel) => [channel.agent_id, {
      agentId: channel.agent_id,
      personaDir: channel.persona_dir,
    }])).values(),
  ];
  const transcript = new LocalTranscript(config.channels.map((channel) => ({
    channelId: channel.channel_id,
    personaDir: channel.persona_dir,
  })));
  const sseClients = new Set<http.ServerResponse>();
  const pendingConfirmations = new Map<string, PendingConfirmation>();
  let heartbeat: NodeJS.Timeout | undefined;

  function broadcast(event: string, data: unknown, id?: string): void {
    const payload = `${id ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of sseClients) client.write(payload);
  }

  function appendMessage(
    channelId: string,
    role: LocalMessageRole,
    kind: LocalMessageKind,
    text: string,
  ): LocalMessage {
    const message: LocalMessage = {
      id: createMessageId(),
      channel_id: channelId,
      role,
      kind,
      text,
      ts: new Date().toISOString(),
    };
    transcript.append(message);
    broadcast("message", message, message.id);
    return message;
  }

  const sessions = createChannelSessions({
    rateLimitMs: config.rateLimitMs,
    process: config.onMessage,
    deliver: async (channelId, text) => {
      const isError = text.startsWith("❌ ");
      appendMessage(channelId, isError ? "system" : "agent", isError ? "error" : "chat", text);
    },
    setTyping: (channelId, active) => broadcast("typing", { channel_id: channelId, active }),
  });

  async function commandResult(command: string, channelId: string): Promise<string> {
    switch (command) {
      case "stats": return config.onStats(channelId);
      case "new": return config.onClear(channelId);
      case "cost": return config.onCost?.(channelId) ?? "Cost reporting is not available in this mode.";
      case "replay": return config.onReplay?.(channelId) ?? "No digest found to replay.";
      case "health": return config.onHealth?.() ?? "Health reporting is not available in this mode.";
      case "digest": return config.onDigest
        ? config.onDigest(channelId)
        : "Digest delivery is not available in this mode.";
      case "refresh": return config.onRefresh
        ? config.onRefresh(channelId)
        : "Feed refresh is not available in this mode.";
      default: throw new Error(`Unknown command: /${command}`);
    }
  }

  const knownCommands = new Set(["stats", "new", "cost", "replay", "health", "digest", "refresh"]);

  async function runCommand(command: string, channelId: string): Promise<void> {
    try {
      appendMessage(channelId, "system", "command", await commandResult(command, channelId));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendMessage(channelId, "system", "error", `❌ ${message}`);
    }
  }

  function resolveConfirmation(id: string, approved: boolean, timedOut: boolean): boolean {
    const pending = pendingConfirmations.get(id);
    if (!pending) return false;
    pendingConfirmations.delete(id);
    clearTimeout(pending.timer);
    pending.resolve(approved);
    broadcast("confirmation_resolved", {
      confirmation_id: id,
      approved,
      timed_out: timedOut,
    });
    const outcome = timedOut ? "timed out and was denied" : approved ? "approved" : "denied";
    appendMessage(pending.channelId, "system", "confirmation", `Confirmation ${outcome}.`);
    return true;
  }

  async function handleMessage(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      jsonResponse(res, 400, { error: error instanceof Error ? error.message : String(error) });
      return;
    }

    const channelId = typeof body.channel_id === "string" ? body.channel_id : "";
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!channelIds.has(channelId)) {
      jsonResponse(res, 404, { error: "Unknown channel" });
      return;
    }
    if (!text || text.length > 50_000) {
      jsonResponse(res, 400, { error: "text must contain between 1 and 50000 characters" });
      return;
    }

    const commandMatch = /^\/([a-z]+)$/u.exec(text);
    if (commandMatch && knownCommands.has(commandMatch[1]!)) {
      appendMessage(channelId, "user", "command", text);
      void runCommand(commandMatch[1]!, channelId);
      jsonResponse(res, 202, { result: "accepted" });
      return;
    }

    const result: SubmitResult = sessions.submit(channelId, text);
    if (result === "accepted" || result === "queued") {
      appendMessage(channelId, "user", "chat", text);
      jsonResponse(res, 202, { result });
      return;
    }
    jsonResponse(res, 409, { result });
  }

  async function handleConfirmation(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      jsonResponse(res, 400, { error: error instanceof Error ? error.message : String(error) });
      return;
    }
    const id = typeof body.confirmation_id === "string" ? body.confirmation_id : "";
    if (typeof body.approve !== "boolean") {
      jsonResponse(res, 400, { error: "approve must be a boolean" });
      return;
    }
    if (!resolveConfirmation(id, body.approve, false)) {
      jsonResponse(res, 404, { error: "Unknown or resolved confirmation" });
      return;
    }
    jsonResponse(res, 200, { resolved: true, approved: body.approve });
  }

  function handleEvents(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(": connected\n\n");
    const lastEventId = req.headers["last-event-id"];
    if (typeof lastEventId === "string" && lastEventId) {
      for (const message of transcript.allAfter(lastEventId)) {
        res.write(`id: ${message.id}\nevent: message\ndata: ${JSON.stringify(message)}\n\n`);
      }
    }
    for (const [id, pending] of pendingConfirmations) {
      res.write(`event: confirmation\ndata: ${JSON.stringify({
        confirmation_id: id,
        channel_id: pending.channelId,
        preview: pending.preview,
        expires_at: pending.expiresAt,
      })}\n\n`);
    }
    sseClients.add(res);
    req.once("close", () => sseClients.delete(res));
  }

  const handleRequest: HttpRouteHandler = async (req, res, url) => {
    if (servePersonaProfile(req, res, url, profileSources)) return true;

    if (url.pathname.startsWith("/api/chat/") && req.method === "POST") {
      if (isCrossOrigin(req)) {
        jsonResponse(res, 403, { error: "Cross-origin requests are not allowed" });
        return true;
      }
      if (!(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        jsonResponse(res, 415, { error: "Content-Type must be application/json" });
        return true;
      }
    }
    if (url.pathname === "/api/chat/channels" && req.method === "GET") {
      jsonResponse(res, 200, config.channels.map(({ persona_dir: personaDir, ...channel }) => ({
        ...channel,
        profile_image_url: personaProfileUrl(channel.agent_id, personaDir),
      })));
      return true;
    }
    if (url.pathname === "/api/chat/history" && req.method === "GET") {
      const channelId = url.searchParams.get("channel") ?? "";
      if (!channelIds.has(channelId)) {
        jsonResponse(res, 404, { error: "Unknown channel" });
        return true;
      }
      const requestedN = Number.parseInt(url.searchParams.get("n") ?? "100", 10);
      jsonResponse(res, 200, transcript.history(channelId, {
        before: url.searchParams.get("before") ?? undefined,
        after: url.searchParams.get("after") ?? undefined,
        n: Number.isFinite(requestedN) ? requestedN : 100,
      }));
      return true;
    }
    if (url.pathname === "/api/chat/message" && req.method === "POST") {
      await handleMessage(req, res);
      return true;
    }
    if (url.pathname === "/api/chat/events" && req.method === "GET") {
      handleEvents(req, res);
      return true;
    }
    if (url.pathname === "/api/chat/confirm" && req.method === "POST") {
      await handleConfirmation(req, res);
      return true;
    }
    if (url.pathname === "/chat" && req.method === "GET" && config.pageHtml) {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
      });
      res.end(config.pageHtml);
      return true;
    }
    return false;
  };

  return {
    handleRequest,
    async start(): Promise<void> {
      transcript.initialize();
      heartbeat = setInterval(() => {
        for (const client of sseClients) client.write(": keepalive\n\n");
      }, 15_000);
    },
    async sendToChannel(channelId: string, text: string): Promise<void> {
      if (!channelIds.has(channelId)) throw new Error(`Unknown local channel: ${channelId}`);
      const kind = text.startsWith("📊 **Weekly Synthesis**") ? "synthesis" : "digest";
      appendMessage(channelId, "agent", kind, text);
    },
    requestConfirmation(channelId: string, preview: string, timeoutMs: number): Promise<boolean> {
      if (!channelIds.has(channelId)) {
        return Promise.reject(new Error(`Unknown local channel: ${channelId}`));
      }
      const id = confirmationId();
      const expiresAt = new Date(Date.now() + timeoutMs).toISOString();
      appendMessage(channelId, "system", "confirmation", preview);
      return new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolveConfirmation(id, false, true), timeoutMs);
        pendingConfirmations.set(id, { channelId, preview, expiresAt, timer, resolve });
        broadcast("confirmation", {
          confirmation_id: id,
          channel_id: channelId,
          preview,
          expires_at: expiresAt,
        });
      });
    },
    async stop(): Promise<void> {
      if (heartbeat) clearInterval(heartbeat);
      for (const id of [...pendingConfirmations.keys()]) resolveConfirmation(id, false, false);
      for (const client of sseClients) client.end();
      sseClients.clear();
    },
  };
}
