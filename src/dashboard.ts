import http from "node:http";
import fs from "node:fs";
import path from "node:path";

import type { SwarmConfig } from "./config.js";
import type { CostLedger } from "./ledger.js";
import type { AgentInstance } from "./manager.js";
import type { EventLogger } from "./logger.js";
import { DEFAULT_MAX_QUEUE_AGE_HOURS, loadPendingItems } from "./feeds.ts";
import { stripProviderPrefix } from "./model.ts";
import { HTML_PAGE } from "./dashboard-page.ts";

export interface DashboardDeps {
  swarmConfig: SwarmConfig;
  agents: AgentInstance[];
  logger: EventLogger;
  ledger: CostLedger;
  startedAt: Date;
}

const DASHBOARD_PORT = 7777;

export type HttpRouteHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
) => boolean | Promise<boolean>;

export interface DashboardServerOptions {
  routeHandlers?: HttpRouteHandler[];
  token?: string;
  host?: string;
  port?: number;
  chatOnly?: boolean;
}

function readJsonFile(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function tailFile(filePath: string, maxLines: number): string[] {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    return lines.slice(-maxLines);
  } catch {
    return [];
  }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getIsoTimestampMs(value: unknown): number | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function summarizePendingByFeed(pending: unknown): {
  totalCount: number;
  oldestPublished: string | null;
  byFeed: Map<string, { pending_count: number; oldest_published: string | null }>;
} {
  const byFeed = new Map<string, { pending_count: number; oldest_published: string | null }>();
  if (!Array.isArray(pending)) {
    return { totalCount: 0, oldestPublished: null, byFeed };
  }

  let oldestPublished: string | null = null;
  let oldestPublishedMs: number | null = null;

  for (const entry of pending) {
    if (!isObjectRecord(entry)) continue;

    const feedKey =
      (typeof entry.feed_id === "string" && entry.feed_id.length > 0
        ? entry.feed_id
        : typeof entry.feed_name === "string" && entry.feed_name.length > 0
          ? entry.feed_name
          : "unknown");

    const existing = byFeed.get(feedKey) ?? { pending_count: 0, oldest_published: null };
    existing.pending_count += 1;

    const published = typeof entry.published === "string" ? entry.published : null;
    const publishedMs = getIsoTimestampMs(published);
    const existingOldestMs = getIsoTimestampMs(existing.oldest_published);

    if (published && publishedMs !== null && (existingOldestMs === null || publishedMs < existingOldestMs)) {
      existing.oldest_published = published;
    }

    if (published && publishedMs !== null && (oldestPublishedMs === null || publishedMs < oldestPublishedMs)) {
      oldestPublished = published;
      oldestPublishedMs = publishedMs;
    }

    byFeed.set(feedKey, existing);
  }

  return {
    totalCount: pending.length,
    oldestPublished,
    byFeed,
  };
}

function formatUptime(startedAt: Date): string {
  const ms = Date.now() - startedAt.getTime();
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m ${seconds % 60}s`;
}

function jsonResponse(res: http.ServerResponse, data: unknown): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function handleApiStatus(deps: DashboardDeps, res: http.ServerResponse): void {
  const mem = process.memoryUsage();

  const agents = deps.agents.map(a => {
    const stats = a.budget.getStats();
    return {
      id: a.id,
      channels: a.raw.channel_ids.length,
      chat_model: a.config.budget.model,
      chat_model_label: stripProviderPrefix(a.config.budget.model),
      digest_model: a.config.budget.digest_model ?? null,
      digest_model_label: a.config.budget.digest_model
        ? stripProviderPrefix(a.config.budget.digest_model)
        : null,
      session: {
        turns: stats.turns,
        input_tokens: stats.inputTokens,
        output_tokens: stats.outputTokens,
        cost_cents: Math.round(stats.costCents * 1000) / 1000,
        tool_calls: stats.toolCalls,
        max_session_cost_cents: a.config.budget.max_session_cost_cents,
      },
      feeds_enabled: a.config.feeds?.enabled ?? false,
    };
  });

  jsonResponse(res, {
    uptime: formatUptime(deps.startedAt),
    uptime_seconds: Math.floor((Date.now() - deps.startedAt.getTime()) / 1000),
    started_at: deps.startedAt.toISOString(),
    default_chat_model: deps.swarmConfig.defaults.budget.model,
    default_chat_model_label: stripProviderPrefix(deps.swarmConfig.defaults.budget.model),
    default_digest_model: deps.swarmConfig.defaults.budget.digest_model ?? null,
    default_digest_model_label: deps.swarmConfig.defaults.budget.digest_model
      ? stripProviderPrefix(deps.swarmConfig.defaults.budget.digest_model)
      : null,
    agent_count: agents.length,
    agents,
    memory_mb: Math.round(mem.rss / 1024 / 1024),
  });
}

function handleApiFeeds(deps: DashboardDeps, res: http.ServerResponse): void {
  const agentFeeds = deps.agents
    .filter(a => a.config.feeds?.enabled)
    .map(a => {
      const personaDir = a.raw.persona_dir;
      const feedsPath = path.resolve(personaDir, "feeds.json");
      const statePath = path.resolve(personaDir, "feeds_state.json");
      const pendingPath = path.resolve(personaDir, "feeds_pending.json");

      const feeds = readJsonFile(feedsPath) ?? [];
      const state = readJsonFile(statePath) as Record<string, unknown> | null;
      const pending = loadPendingItems(pendingPath, {
        feedsPath,
        maxQueueAgeHours: a.config.feeds?.max_queue_age_hours,
        maxContentAgeHours: a.config.feeds?.max_content_age_hours,
      });
      const pendingSummary = summarizePendingByFeed(pending);

      return {
        agent_id: a.id,
        feeds: Array.isArray(feeds)
          ? feeds.map((feed) => {
              const feedId = isObjectRecord(feed) && typeof feed.id === "string" ? feed.id : "unknown";
              const feedPending = pendingSummary.byFeed.get(feedId) ?? { pending_count: 0, oldest_published: null };
              return {
                ...feed,
                pending_count: feedPending.pending_count,
                oldest_pending_published: feedPending.oldest_published,
              };
            })
          : [],
        state: state ?? {},
        pending_count: pendingSummary.totalCount,
        oldest_pending_published: pendingSummary.oldestPublished,
        digest_times: a.config.feeds?.digest_times ?? [],
        check_interval_minutes: a.config.feeds?.check_interval_minutes ?? null,
        max_queue_age_hours: a.config.feeds?.max_queue_age_hours ?? DEFAULT_MAX_QUEUE_AGE_HOURS,
        max_content_age_hours: a.config.feeds?.max_content_age_hours ?? null,
        waking_hours: a.config.feeds
          ? `${a.config.feeds.waking_hours_start}:00\u2013${a.config.feeds.waking_hours_end}:00 PT`
          : null,
      };
    });

  jsonResponse(res, { agents: agentFeeds });
}

function handleApiEvents(deps: DashboardDeps, res: http.ServerResponse, url: URL): void {
  const maxLines = Math.min(Number(url.searchParams.get("n")) || 50, 200);
  const logPath = deps.logger.getLogPath();
  const lines = tailFile(logPath, maxLines);
  const events = lines.map((line) => {
    try { return JSON.parse(line); } catch { return { raw: line }; }
  });
  jsonResponse(res, { events, count: events.length, log_file: path.basename(logPath) });
}

function handleApiCost(deps: DashboardDeps, res: http.ServerResponse): void {
  const today = deps.ledger.getTodayCost();
  const month = deps.ledger.getMonthCost();
  const monthlyBudget = deps.swarmConfig.defaults.budget.monthly_budget_cents ?? null;

  jsonResponse(res, {
    today: { cost_cents: Math.round(today.costCents * 1000) / 1000, turns: today.turns },
    month: { cost_cents: Math.round(month.costCents * 1000) / 1000, turns: month.turns, days: month.days },
    monthly_budget_cents: monthlyBudget,
  });
}

// Simple "A" monogram favicon in the dashboard accent color
const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
<rect width="32" height="32" rx="6" fill="#58a6ff"/>
<text x="16" y="24" text-anchor="middle" font-family="system-ui,sans-serif" font-weight="bold" font-size="22" fill="#0d1117">A</text>
</svg>`;

function serveHtml(res: http.ServerResponse, localChatEnabled: boolean): void {
  res.writeHead(200, { "Content-Type": "text/html" });
  const chatLink = localChatEnabled
    ? '<a class="chat-link" href="/chat">Local Chat</a>'
    : "";
  res.end(HTML_PAGE.replace("<!--LOCAL_CHAT_LINK-->", chatLink));
}

function serveFavicon(res: http.ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "image/svg+xml",
    "Cache-Control": "public, max-age=86400",
  });
  res.end(FAVICON_SVG);
}

function requestHasToken(req: http.IncomingMessage, token: string): boolean {
  if (req.headers.authorization === `Bearer ${token}`) return true;
  const cookies = (req.headers.cookie ?? "").split(";");
  return cookies.some((cookie) => {
    const [name, ...valueParts] = cookie.trim().split("=");
    if (name !== "newsteam_token") return false;
    try {
      return decodeURIComponent(valueParts.join("=")) === token;
    } catch {
      return false;
    }
  });
}

function authorizeRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  token: string | undefined,
): boolean {
  if (!token) return true;

  if (url.pathname === "/chat" && url.searchParams.get("token") === token) {
    res.writeHead(302, {
      Location: "/chat",
      "Set-Cookie": `newsteam_token=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/`,
      "Cache-Control": "no-store",
    });
    res.end();
    return false;
  }

  if (requestHasToken(req, token)) return true;
  res.writeHead(401, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
  res.end("Unauthorized");
  return false;
}

function startServer(
  deps: DashboardDeps | undefined,
  options: DashboardServerOptions,
): http.Server {
  const host = options.host ?? process.env.DASHBOARD_HOST ?? "127.0.0.1";
  const port = options.port ?? DASHBOARD_PORT;
  const routeHandlers = options.routeHandlers ?? [];

  const server = http.createServer((req, res) => {
    void (async () => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = url.pathname;

    try {
      if (!authorizeRequest(req, res, url, options.token)) return;

      for (const handler of routeHandlers) {
        if (await handler(req, res, url)) return;
      }

      if (options.chatOnly && pathname === "/") {
        res.writeHead(302, { Location: "/chat" });
        res.end();
        return;
      }

      if (deps) {
        if (pathname === "/" || pathname === "/index.html") {
          return serveHtml(res, deps.swarmConfig.channel.provider === "local");
        }
        if (pathname === "/favicon.ico") return serveFavicon(res);
        if (pathname === "/api/status") return handleApiStatus(deps, res);
        if (pathname === "/api/feeds") return handleApiFeeds(deps, res);
        if (pathname === "/api/events") return handleApiEvents(deps, res, url);
        if (pathname === "/api/cost") return handleApiCost(deps, res);
      }

      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
    } catch (error) {
      console.error("[dashboard] Request error:", error);
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal server error");
    }
    })();
  });

  server.listen(port, host, () => {
    const address = server.address();
    const actualPort = typeof address === "object" && address ? address.port : port;
    const displayHost = host === "0.0.0.0" ? "127.0.0.1" : host;
    const label = options.chatOnly ? "Local chat" : "Mission control";
    console.log(`[dashboard] ${label} at http://${displayHost}:${actualPort}`);
  });

  return server;
}

export function startDashboard(
  deps: DashboardDeps,
  options: DashboardServerOptions = {},
): http.Server {
  return startServer(deps, options);
}

export function startChatServer(
  routeHandlers: HttpRouteHandler[],
  options: Omit<DashboardServerOptions, "routeHandlers" | "chatOnly"> = {},
): http.Server {
  return startServer(undefined, { ...options, routeHandlers, chatOnly: true });
}
