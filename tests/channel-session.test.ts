import assert from "node:assert/strict";
import test from "node:test";

import { createChannelSessions } from "../src/channel-session.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("channel sessions accept one turn, queue one, then report busy", async () => {
  const first = deferred<string>();
  const second = deferred<string>();
  const processed: string[] = [];
  const delivered: string[] = [];
  const typing: boolean[] = [];

  const sessions = createChannelSessions({
    rateLimitMs: 1_000,
    process: async (text) => {
      processed.push(text);
      return text === "first" ? first.promise : second.promise;
    },
    deliver: async (_channelId, text) => { delivered.push(text); },
    setTyping: (_channelId, active) => { typing.push(active); },
  });

  assert.equal(sessions.submit("chat", "first"), "accepted");
  assert.equal(sessions.submit("chat", "second"), "queued");
  assert.equal(sessions.submit("chat", "third"), "busy");
  assert.deepEqual(processed, ["first"]);

  first.resolve("reply:first");
  await flush();
  assert.deepEqual(processed, ["first", "second"]);
  assert.deepEqual(delivered, ["reply:first"]);

  second.resolve("reply:second");
  await flush();
  assert.deepEqual(delivered, ["reply:first", "reply:second"]);
  assert.deepEqual(typing, [true, false, true, false]);
});

test("channel sessions rate limit a new idle turn", async () => {
  const sessions = createChannelSessions({
    rateLimitMs: 10_000,
    process: async (text) => `reply:${text}`,
    deliver: async () => {},
  });

  assert.equal(sessions.submit("chat", "first"), "accepted");
  await flush();
  assert.equal(sessions.submit("chat", "second"), "rate_limited");
});

test("channel sessions convert processing failures into error deliveries", async () => {
  const delivered: string[] = [];
  const sessions = createChannelSessions({
    rateLimitMs: 1,
    process: async () => { throw new Error("turn failed"); },
    deliver: async (_channelId, text) => { delivered.push(text); },
  });

  assert.equal(sessions.submit("chat", "hello"), "accepted");
  await flush();
  assert.deepEqual(delivered, ["❌ turn failed"]);
});
