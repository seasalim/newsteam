import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, writeFileSync } from "node:fs";
import type http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { startChatServer } from "../src/dashboard.ts";
import { createLocalChannelAdapter } from "../src/local-channel.ts";
import { LOCAL_CHANNEL_PAGE } from "../src/local-channel-page.ts";
import type { LocalMessage } from "../src/local-transcript.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function listen(server: http.Server): Promise<string> {
  if (!server.listening) await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server address");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function post(baseUrl: string, route: string, body: unknown, headers: HeadersInit = {}) {
  return fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function waitForHistory(baseUrl: string, expectedCount: number): Promise<LocalMessage[]> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/chat/history?channel=chat&n=100`);
    const messages = await response.json() as LocalMessage[];
    if (messages.length >= expectedCount) return messages;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`History did not reach ${expectedCount} messages`);
}

function createAdapter(overrides: {
  onMessage?: (text: string) => Promise<string>;
  personaDir?: string;
} = {}) {
  const personaDir = overrides.personaDir ?? mkdtempSync(path.join(tmpdir(), "newsteam-local-channel-"));
  return createLocalChannelAdapter({
    channels: [{ channel_id: "chat", agent_id: "agent", is_feed_channel: false, persona_dir: personaDir }],
    rateLimitMs: 1_000,
    pageHtml: LOCAL_CHANNEL_PAGE,
    onMessage: overrides.onMessage ?? (async (text) => `reply:${text}`),
    onStats: () => "stats output",
    onClear: () => "cleared",
    onCost: () => "cost output",
  });
}

test("local HTTP channel persists accepted and queued turns and rejects a third", async (t) => {
  const first = deferred<string>();
  const second = deferred<string>();
  let calls = 0;
  const adapter = createAdapter({ onMessage: async () => (++calls === 1 ? first.promise : second.promise) });
  await adapter.start();
  const server = startChatServer([adapter.handleRequest], { host: "127.0.0.1", port: 0 });
  const baseUrl = await listen(server);
  t.after(async () => { await adapter.stop(); await close(server); });

  assert.equal((await post(baseUrl, "/api/chat/message", { channel_id: "chat", text: "first" })).status, 202);
  const queued = await post(baseUrl, "/api/chat/message", { channel_id: "chat", text: "second" });
  assert.equal(queued.status, 202);
  assert.deepEqual(await queued.json(), { result: "queued" });
  const busy = await post(baseUrl, "/api/chat/message", { channel_id: "chat", text: "third" });
  assert.equal(busy.status, 409);
  assert.deepEqual(await busy.json(), { result: "busy" });

  first.resolve("reply:first");
  await waitForHistory(baseUrl, 3);
  second.resolve("reply:second");
  const history = await waitForHistory(baseUrl, 4);
  assert.deepEqual(history.map((entry) => entry.text), ["first", "second", "reply:first", "reply:second"]);
});

test("local HTTP channel dispatches commands and rejects unknown channels", async (t) => {
  const adapter = createAdapter();
  await adapter.start();
  const server = startChatServer([adapter.handleRequest], { host: "127.0.0.1", port: 0 });
  const baseUrl = await listen(server);
  t.after(async () => { await adapter.stop(); await close(server); });

  assert.equal((await post(baseUrl, "/api/chat/message", { channel_id: "missing", text: "hello" })).status, 404);
  assert.equal((await post(baseUrl, "/api/chat/message", { channel_id: "chat", text: "/stats" })).status, 202);
  const history = await waitForHistory(baseUrl, 2);
  assert.deepEqual(history.map((entry) => [entry.role, entry.kind, entry.text]), [
    ["user", "command", "/stats"],
    ["system", "command", "stats output"],
  ]);
});

test("local confirmations approve through SSE and deny on timeout", async (t) => {
  const adapter = createAdapter();
  await adapter.start();
  const server = startChatServer([adapter.handleRequest], { host: "127.0.0.1", port: 0 });
  const baseUrl = await listen(server);
  t.after(async () => { await adapter.stop(); await close(server); });

  const controller = new AbortController();
  const response = await fetch(`${baseUrl}/api/chat/events`, { signal: controller.signal });
  const reader = response.body!.getReader();
  await reader.read();
  const confirmation = adapter.requestConfirmation("chat", "Run tool?", 2_000);
  let buffer = "";
  let confirmationId = "";
  while (!confirmationId) {
    const chunk = await reader.read();
    buffer += new TextDecoder().decode(chunk.value);
    for (const block of buffer.split("\n\n")) {
      if (!block.includes("event: confirmation")) continue;
      const data = block.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
      if (data) confirmationId = (JSON.parse(data) as { confirmation_id: string }).confirmation_id;
    }
  }
  const approved = await post(baseUrl, "/api/chat/confirm", { confirmation_id: confirmationId, approve: true });
  assert.equal(approved.status, 200);
  assert.equal(await confirmation, true);
  assert.equal(await adapter.requestConfirmation("chat", "Timeout tool?", 5), false);
  controller.abort();
});

test("shared server token protects chat APIs and supports token-cookie entry", async (t) => {
  const personaDir = mkdtempSync(path.join(tmpdir(), "newsteam-local-channel-profile-"));
  copyFileSync(
    path.join(process.cwd(), "examples", "personas", "kingclawd", "PROFILE.png"),
    path.join(personaDir, "PROFILE.png"),
  );
  const adapter = createAdapter({ personaDir });
  await adapter.start();
  const server = startChatServer([adapter.handleRequest], {
    host: "127.0.0.1",
    port: 0,
    token: "secret token",
  });
  const baseUrl = await listen(server);
  t.after(async () => { await adapter.stop(); await close(server); });

  assert.equal((await fetch(`${baseUrl}/api/chat/channels`)).status, 401);
  assert.equal((await fetch(`${baseUrl}/api/personas/agent/profile.png`)).status, 401);
  assert.equal((await fetch(`${baseUrl}/api/chat/channels`, {
    headers: { Authorization: "Bearer secret token" },
  })).status, 200);
  assert.equal((await fetch(`${baseUrl}/api/personas/agent/profile.png`, {
    headers: { Authorization: "Bearer secret token" },
  })).status, 200);
  const entry = await fetch(`${baseUrl}/chat?token=${encodeURIComponent("secret token")}`, { redirect: "manual" });
  assert.equal(entry.status, 302);
  assert.equal(entry.headers.get("location"), "/chat");
  assert.match(entry.headers.get("set-cookie") ?? "", /newsteam_token=/u);
});

test("local channel exposes validated profile metadata and cacheable image bytes", async (t) => {
  const personaDir = mkdtempSync(path.join(tmpdir(), "newsteam-local-channel-profile-"));
  copyFileSync(
    path.join(process.cwd(), "examples", "personas", "kingclawd", "PROFILE.png"),
    path.join(personaDir, "PROFILE.png"),
  );
  const adapter = createAdapter({ personaDir });
  await adapter.start();
  const server = startChatServer([adapter.handleRequest], { host: "127.0.0.1", port: 0 });
  const baseUrl = await listen(server);
  t.after(async () => { await adapter.stop(); await close(server); });

  const channelsResponse = await fetch(`${baseUrl}/api/chat/channels`);
  const channelsText = await channelsResponse.text();
  assert.doesNotMatch(channelsText, /persona_dir|newsteam-local-channel-profile/u);
  assert.deepEqual(JSON.parse(channelsText), [{
    channel_id: "chat",
    agent_id: "agent",
    is_feed_channel: false,
    profile_image_url: "/api/personas/agent/profile.png",
  }]);

  const profile = await fetch(`${baseUrl}/api/personas/agent/profile.png`);
  assert.equal(profile.status, 200);
  assert.equal(profile.headers.get("content-type"), "image/png");
  assert.equal(profile.headers.get("x-content-type-options"), "nosniff");
  assert.match(profile.headers.get("cache-control") ?? "", /private, max-age=3600/u);
  const bytes = Buffer.from(await profile.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);

  const etag = profile.headers.get("etag");
  assert.ok(etag);
  const cached = await fetch(`${baseUrl}/api/personas/agent/profile.png`, {
    headers: { "If-None-Match": etag },
  });
  assert.equal(cached.status, 304);
  assert.equal((await fetch(`${baseUrl}/api/personas/unknown/profile.png`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/api/personas/%2Fetc%2Fpasswd/profile.png`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/api/personas/agent/profile.png`, { method: "POST" })).status, 405);
});

test("local channel falls back when PROFILE.png is missing or invalid", async (t) => {
  const personaDir = mkdtempSync(path.join(tmpdir(), "newsteam-local-channel-profile-"));
  writeFileSync(path.join(personaDir, "PROFILE.png"), "not a png", "utf8");
  const adapter = createAdapter({ personaDir });
  await adapter.start();
  const server = startChatServer([adapter.handleRequest], { host: "127.0.0.1", port: 0 });
  const baseUrl = await listen(server);
  t.after(async () => { await adapter.stop(); await close(server); });

  const channels = await fetch(`${baseUrl}/api/chat/channels`).then((response) => response.json());
  assert.equal(channels[0].profile_image_url, null);
  assert.equal((await fetch(`${baseUrl}/api/personas/agent/profile.png`)).status, 404);
});

test("local channel serves CSP-protected chat and rejects browser cross-origin posts", async (t) => {
  const adapter = createAdapter();
  await adapter.start();
  const server = startChatServer([adapter.handleRequest], { host: "127.0.0.1", port: 0 });
  const baseUrl = await listen(server);
  t.after(async () => { await adapter.stop(); await close(server); });

  const page = await fetch(`${baseUrl}/chat`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'self'/u);

  const crossOrigin = await fetch(`${baseUrl}/api/chat/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
    body: JSON.stringify({ channel_id: "chat", text: "hello" }),
  });
  assert.equal(crossOrigin.status, 403);

  const unsafeContentType = await fetch(`${baseUrl}/api/chat/message`, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify({ channel_id: "chat", text: "hello" }),
  });
  assert.equal(unsafeContentType.status, 415);
});

test("sendToChannel records full digest messages without splitting", async () => {
  const adapter = createAdapter();
  await adapter.start();
  const longDigest = "D".repeat(3_000);
  await adapter.sendToChannel("chat", longDigest);
  const server = startChatServer([adapter.handleRequest], { host: "127.0.0.1", port: 0 });
  const baseUrl = await listen(server);
  const history = await waitForHistory(baseUrl, 1);
  assert.equal(history[0]!.kind, "digest");
  assert.equal(history[0]!.text.length, 3_000);
  await adapter.stop();
  await close(server);
});
