import assert from "node:assert/strict";
import test from "node:test";

import { Events } from "discord.js";

import { createBot, isAllowed, splitMessage } from "../src/bot.ts";

function createAuthConfig() {
  return {
    allowedUserId: "allowed-user",
    allowedChannelIds: ["allowed-channel"],
  };
}

function checkAllowed(overrides: {
  authorId?: string;
  channelId?: string;
  isBot?: boolean;
} = {}): boolean {
  return isAllowed(
    overrides.authorId ?? "allowed-user",
    overrides.channelId ?? "allowed-channel",
    overrides.isBot ?? false,
    createAuthConfig(),
  );
}

test("isAllowed returns false for bot messages", () => {
  assert.equal(checkAllowed({ isBot: true }), false);
});

test("isAllowed returns false for wrong user ID", () => {
  assert.equal(checkAllowed({ authorId: "wrong-user" }), false);
});

test("isAllowed returns false for wrong channel ID", () => {
  assert.equal(checkAllowed({ channelId: "wrong-channel" }), false);
});

test("isAllowed returns true for correct user and channel", () => {
  assert.equal(checkAllowed(), true);
});

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvedValue) => {
    resolve = resolvedValue;
  });

  return { promise, resolve };
}

function createMessage(content: string) {
  const replies: string[] = [];
  const channelMessages: string[] = [];

  return {
    author: { id: "allowed-user", bot: false },
    channel: {
      id: "allowed-channel",
      send: async (response: string) => { channelMessages.push(response); },
    },
    content,
    replies,
    channelMessages,
    reply: async (response: string) => {
      replies.push(response);
    },
  };
}

async function flushAsyncWork() {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

async function waitFor(condition: () => boolean, timeoutMs: number = 5_000) {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Condition was not met within ${timeoutMs}ms`);
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 25);
    });
  }
}

test("createBot queues one message while a turn is in flight", async () => {
  const firstTurn = createDeferred<string>();
  const secondTurn = createDeferred<string>();
  const startedMessages: string[] = [];
  let callCount = 0;

  const bot = createBot({
    token: "token",
    allowedUserId: "allowed-user",
    allowedChannelIds: ["allowed-channel"],
    rateLimitMs: 1000,
    onMessage: async (message: string) => {
      startedMessages.push(message);
      callCount += 1;

      if (callCount === 1) {
        return firstTurn.promise;
      }

      return secondTurn.promise;
    },
  });

  const firstMessage = createMessage("first");
  const secondMessage = createMessage("second");
  const thirdMessage = createMessage("third");

  bot.client.emit(Events.MessageCreate, firstMessage);
  bot.client.emit(Events.MessageCreate, secondMessage);
  bot.client.emit(Events.MessageCreate, thirdMessage);

  await flushAsyncWork();

  assert.deepEqual(startedMessages, ["first"]);
  assert.deepEqual(firstMessage.channelMessages, []);
  assert.deepEqual(secondMessage.channelMessages, []);
  assert.deepEqual(thirdMessage.replies, ["🦞 Still thinking... hold that thought."]);

  firstTurn.resolve("first response");
  await flushAsyncWork();

  assert.deepEqual(startedMessages, ["first", "second"]);
  assert.deepEqual(firstMessage.channelMessages, ["first response"]);
  assert.deepEqual(secondMessage.channelMessages, []);

  secondTurn.resolve("second response");
  await flushAsyncWork();

  assert.deepEqual(secondMessage.channelMessages, ["second response"]);
});

test("createBot rate limits rapid accepted messages", async () => {
  const seenMessages: string[] = [];

  const bot = createBot({
    token: "token",
    allowedUserId: "allowed-user",
    allowedChannelIds: ["allowed-channel"],
    rateLimitMs: 10_000,
    onMessage: async (message: string) => {
      seenMessages.push(message);
      return `reply:${message}`;
    },
  });

  const firstMessage = createMessage("first");
  const secondMessage = createMessage("second");

  bot.client.emit(Events.MessageCreate, firstMessage);
  await flushAsyncWork();
  bot.client.emit(Events.MessageCreate, secondMessage);
  await flushAsyncWork();

  assert.deepEqual(seenMessages, ["first"]);
  assert.deepEqual(firstMessage.channelMessages, ["reply:first"]);
  assert.deepEqual(secondMessage.replies, ["🦞 Still thinking... hold that thought."]);
});

test("sendToChannel splits long messages instead of truncating", async () => {
  const sentPayloads: Array<{
    content: string;
    allowedMentions?: { parse: string[] };
  }> = [];

  const bot = createBot({
    token: "token",
    allowedUserId: "allowed-user",
    allowedChannelIds: ["allowed-channel"],
    rateLimitMs: 1000,
    onMessage: async () => "ignored",
    onStats: () => "stats",
    onClear: () => "cleared",
  });

  Object.defineProperty(bot.client, "channels", {
    value: {
      fetch: async (channelId: string) => {
        assert.equal(channelId, "feed-channel");
        return {
          send: async (payload: {
            content: string;
            allowedMentions?: { parse: string[] };
          }) => {
            sentPayloads.push(payload);
          },
        };
      },
    },
  });

  // Build a message with two paragraphs that together exceed 2000 chars
  const para1 = "A".repeat(1200);
  const para2 = "B".repeat(1200);
  const oversizedMessage = `${para1}\n\n${para2}`;
  await bot.sendToChannel("feed-channel", oversizedMessage);

  assert.equal(sentPayloads.length, 2);
  assert.ok(sentPayloads[0]!.content.length <= 2000);
  assert.ok(sentPayloads[1]!.content.length <= 2000);
  assert.deepEqual(sentPayloads[0]?.allowedMentions, { parse: [] });
  assert.deepEqual(sentPayloads[1]?.allowedMentions, { parse: [] });
});

// --- splitMessage tests ---

test("splitMessage returns single chunk for short messages", () => {
  const chunks = splitMessage("Hello world");
  assert.deepEqual(chunks, ["Hello world"]);
});

test("splitMessage splits on paragraph breaks", () => {
  const para1 = "A".repeat(1500);
  const para2 = "B".repeat(1500);
  const chunks = splitMessage(`${para1}\n\n${para2}`);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0], para1);
  assert.equal(chunks[1], para2);
});

test("splitMessage falls back to line breaks when no paragraph break fits", () => {
  const line1 = "A".repeat(1500);
  const line2 = "B".repeat(1500);
  const chunks = splitMessage(`${line1}\n${line2}`);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0], line1);
  assert.equal(chunks[1], line2);
});

test("onClear callback is invoked for /new command", async () => {
  let clearCalled = false;

  const bot = createBot({
    token: "token",
    allowedUserId: "allowed-user",
    allowedChannelIds: ["allowed-channel"],
    rateLimitMs: 1000,
    onMessage: async () => "reply",
    onStats: () => "stats",
    onClear: () => {
      clearCalled = true;
      return "cleared";
    },
  });

  const replies: string[] = [];
  const interaction = {
    isChatInputCommand: () => true,
    user: { id: "allowed-user" },
    channelId: "allowed-channel",
    commandName: "new",
    reply: async (content: string) => {
      replies.push(content);
    },
  };

  bot.client.emit(Events.InteractionCreate, interaction);
  await flushAsyncWork();

  assert.equal(clearCalled, true);
  assert.deepEqual(replies, ["cleared"]);
});

test("/new command supports async clear callbacks", async () => {
  const clearResult = createDeferred<string>();

  const bot = createBot({
    token: "token",
    allowedUserId: "allowed-user",
    allowedChannelIds: ["allowed-channel"],
    rateLimitMs: 1000,
    onMessage: async () => "reply",
    onStats: () => "stats",
    onClear: () => clearResult.promise,
  });

  const replies: string[] = [];
  const interaction = {
    isChatInputCommand: () => true,
    user: { id: "allowed-user" },
    channelId: "allowed-channel",
    commandName: "new",
    reply: async (content: string) => {
      replies.push(content);
    },
  };

  bot.client.emit(Events.InteractionCreate, interaction);
  await flushAsyncWork();
  assert.deepEqual(replies, []);

  clearResult.resolve("cleared later");
  await flushAsyncWork();

  assert.deepEqual(replies, ["cleared later"]);
});

// --- /replay command tests ---

test("onReplay callback is invoked for /replay command", async () => {
  let replayCalled = false;

  const bot = createBot({
    token: "token",
    allowedUserId: "allowed-user",
    allowedChannelIds: ["allowed-channel"],
    rateLimitMs: 1000,
    onMessage: async () => "reply",
    onStats: () => "stats",
    onClear: () => "cleared",
    onReplay: () => {
      replayCalled = true;
      return "Here is the last digest.";
    },
  });

  const replies: string[] = [];
  const interaction = {
    isChatInputCommand: () => true,
    user: { id: "allowed-user" },
    channelId: "allowed-channel",
    commandName: "replay",
    reply: async (content: string) => {
      replies.push(content);
    },
  };

  bot.client.emit(Events.InteractionCreate, interaction);
  await flushAsyncWork();

  assert.equal(replayCalled, true);
  assert.deepEqual(replies, ["Here is the last digest."]);
});

test("onReplay returns fallback when no digest available", async () => {
  const bot = createBot({
    token: "token",
    allowedUserId: "allowed-user",
    allowedChannelIds: ["allowed-channel"],
    rateLimitMs: 1000,
    onMessage: async () => "reply",
    onStats: () => "stats",
    onClear: () => "cleared",
    onReplay: () => null,
  });

  const replies: string[] = [];
  const interaction = {
    isChatInputCommand: () => true,
    user: { id: "allowed-user" },
    channelId: "allowed-channel",
    commandName: "replay",
    reply: async (content: string) => {
      replies.push(content);
    },
  };

  bot.client.emit(Events.InteractionCreate, interaction);
  await flushAsyncWork();

  assert.deepEqual(replies, ["No digest found to replay."]);
});

// --- /health command tests ---

test("onHealth callback is invoked for /health command", async () => {
  let healthCalled = false;

  const bot = createBot({
    token: "token",
    allowedUserId: "allowed-user",
    allowedChannelIds: ["allowed-channel"],
    rateLimitMs: 1000,
    onMessage: async () => "reply",
    onStats: () => "stats",
    onClear: () => "cleared",
    onHealth: () => {
      healthCalled = true;
      return "System is healthy.";
    },
  });

  const replies: string[] = [];
  const interaction = {
    isChatInputCommand: () => true,
    user: { id: "allowed-user" },
    channelId: "allowed-channel",
    commandName: "health",
    reply: async (content: string) => {
      replies.push(content);
    },
  };

  bot.client.emit(Events.InteractionCreate, interaction);
  await flushAsyncWork();

  assert.equal(healthCalled, true);
  assert.deepEqual(replies, ["System is healthy."]);
});

test("slash command errors after deferReply are reported via editReply", async () => {
  const bot = createBot({
    token: "token",
    allowedUserId: "allowed-user",
    allowedChannelIds: ["allowed-channel"],
    rateLimitMs: 1000,
    onMessage: async () => "reply",
    onStats: () => "stats",
    onClear: () => "cleared",
    onDigest: async () => {
      throw new Error("digest exploded");
    },
  });

  const editReplies: string[] = [];
  const interaction = {
    isChatInputCommand: () => true,
    user: { id: "allowed-user" },
    channelId: "allowed-channel",
    commandName: "digest",
    deferred: false,
    deferReply: async () => {
      interaction.deferred = true;
    },
    editReply: async (content: string) => {
      editReplies.push(content);
    },
  };

  bot.client.emit(Events.InteractionCreate, interaction);
  await waitFor(() => editReplies.length === 1);

  assert.deepEqual(editReplies, ["❌ digest exploded"]);
});

test("joining a guild after startup registers slash commands for it", async () => {
  const bot = createBot({
    token: "token",
    allowedUserId: "allowed-user",
    allowedChannelIds: ["allowed-channel"],
    rateLimitMs: 1000,
    onMessage: async () => "reply",
    onStats: () => "stats",
    onClear: () => "cleared",
  });

  const registered: Array<Array<{ name: string }>> = [];
  const guild = {
    id: "new-guild",
    commands: {
      set: async (commands: Array<{ name: string }>) => {
        registered.push(commands);
      },
    },
  };

  bot.client.emit(Events.GuildCreate, guild);
  await waitFor(() => registered.length === 1);

  const names = registered[0]!.map((command) => command.name);
  assert.deepEqual(names, ["stats", "new", "cost", "replay", "health", "digest", "refresh"]);
});

test("slash command errors before any reply are reported via reply", async () => {
  const bot = createBot({
    token: "token",
    allowedUserId: "allowed-user",
    allowedChannelIds: ["allowed-channel"],
    rateLimitMs: 1000,
    onMessage: async () => "reply",
    onStats: () => {
      throw new Error("stats exploded");
    },
    onClear: () => "cleared",
  });

  const replies: string[] = [];
  const interaction = {
    isChatInputCommand: () => true,
    user: { id: "allowed-user" },
    channelId: "allowed-channel",
    commandName: "stats",
    reply: async (content: string) => {
      replies.push(content);
    },
  };

  bot.client.emit(Events.InteractionCreate, interaction);
  await waitFor(() => replies.length === 1);

  assert.deepEqual(replies, ["❌ stats exploded"]);
});
