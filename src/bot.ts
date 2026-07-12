import {
  Client,
  Events,
  GatewayIntentBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";

import {
  isSendableChannel,
  safeSend,
  safeTruncate,
  splitMessage,
  type SendableChannel,
} from "./bot-messaging.ts";
export { splitMessage } from "./bot-messaging.ts";

const STILL_THINKING_MESSAGE = "🦞 Still thinking... hold that thought.";

export interface BotConfig {
  token: string;
  allowedUserId: string;
  allowedChannelIds: string[];
  rateLimitMs: number;
  onMessage: (message: string, channelId: string) => Promise<string>;
  onStats: (channelId: string) => string;
  onClear: (channelId: string) => string | Promise<string>;
  onCost?: (channelId: string) => string;
  onReplay?: (channelId: string) => string | null;
  onHealth?: () => string;
  onDigest?: (channelId: string) => Promise<string>;
  onRefresh?: (channelId: string) => Promise<string>;
}

export interface AuthConfig {
  allowedUserId: string;
  allowedChannelIds: string[];
}

export function isAllowed(
  authorId: string,
  channelId: string,
  isBot: boolean,
  config: AuthConfig,
): boolean {
  if (isBot) {
    return false;
  }

  if (authorId !== config.allowedUserId) {
    return false;
  }

  return config.allowedChannelIds.includes(channelId);
}

export function createBot(config: BotConfig) {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMessageReactions,
    ],
  });
  type QueuedMessage = {
    author: { id: string; bot: boolean };
    channel: { id: string; send: (content: string) => Promise<unknown> };
    content: string;
    reply: (content: string) => Promise<unknown>;
  };

  type ChannelState = {
    inFlight: boolean;
    queuedMessage: QueuedMessage | null;
    lastAcceptedMessageAt: number;
  };

  const channelStates = new Map<string, ChannelState>();

  function getChannelState(channelId: string): ChannelState {
    let state = channelStates.get(channelId);
    if (!state) {
      state = { inFlight: false, queuedMessage: null, lastAcceptedMessageAt: 0 };
      channelStates.set(channelId, state);
    }
    return state;
  }

  function buildSlashCommands() {
    return [
      new SlashCommandBuilder()
        .setName("stats")
        .setDescription("Show session statistics"),
      new SlashCommandBuilder()
        .setName("new")
        .setDescription("Start a new conversation"),
      new SlashCommandBuilder()
        .setName("cost")
        .setDescription("Show cost ledger (today + month)"),
      new SlashCommandBuilder()
        .setName("replay")
        .setDescription("Re-post the last feed digest"),
      new SlashCommandBuilder()
        .setName("health")
        .setDescription("Show system health and status"),
      new SlashCommandBuilder()
        .setName("digest")
        .setDescription("Force an immediate feed digest delivery"),
      new SlashCommandBuilder()
        .setName("refresh")
        .setDescription("Force a fresh pull of all feeds (ignores schedules)"),
    ];
  }

  async function registerCommands(): Promise<void> {
    if (!client.application) {
      throw new Error("Discord application is not ready");
    }

    const commands = buildSlashCommands();

    // Clear stale global commands, then register per-guild for instant propagation
    await client.application.commands.set([]);

    for (const guild of client.guilds.cache.values()) {
      await guild.commands.set(commands);
    }
  }

  async function processMessage(message: {
    author: { id: string; bot: boolean };
    channel: {
      id: string;
      send: (content: string) => Promise<unknown>;
      sendTyping?: () => Promise<unknown>;
    };
    content: string;
    reply: (content: string) => Promise<unknown>;
  }): Promise<void> {
    const state = getChannelState(message.channel.id);
    state.inFlight = true;
    state.lastAcceptedMessageAt = Date.now();

    // Show typing indicator while agent is thinking
    const typingInterval = message.channel.sendTyping
      ? (() => {
          void message.channel.sendTyping!();
          return setInterval(() => void message.channel.sendTyping!(), 8000);
        })()
      : null;

    try {
      const response = await config.onMessage(message.content, message.channel.id);
      if (typingInterval) clearInterval(typingInterval);
      await safeSend(message.channel, response);
    } catch (error) {
      if (typingInterval) clearInterval(typingInterval);
      const errorMessage = error instanceof Error ? error.message : String(error);
      await safeSend(message.channel, `❌ ${errorMessage}`);
    } finally {
      state.inFlight = false;

      if (state.queuedMessage !== null) {
        const nextMessage = state.queuedMessage;
        state.queuedMessage = null;
        void processMessage(nextMessage);
      }
    }
  }

  client.on(Events.MessageCreate, async (message) => {
    if (
      !isAllowed(message.author.id, message.channel.id, message.author.bot, {
        allowedUserId: config.allowedUserId,
        allowedChannelIds: config.allowedChannelIds,
      })
    ) {
      return;
    }

    const state = getChannelState(message.channel.id);

    if (state.inFlight) {
      if (state.queuedMessage !== null) {
        await message.reply(STILL_THINKING_MESSAGE);
        return;
      }

      state.queuedMessage = message;
      return;
    }

    if (Date.now() - state.lastAcceptedMessageAt < config.rateLimitMs) {
      await message.reply(STILL_THINKING_MESSAGE);
      return;
    }

    void processMessage(message);
  });

  client.once(Events.ClientReady, async () => {
    try {
      await registerCommands();
    } catch (error) {
      console.error("[bot] Failed to register slash commands:", error);
    }
  });

  // Guilds joined after startup don't get commands from the ClientReady
  // registration pass — register them as they arrive.
  client.on(Events.GuildCreate, async (guild) => {
    try {
      await guild.commands.set(buildSlashCommands());
    } catch (error) {
      console.error(`[bot] Failed to register slash commands for guild ${guild.id}:`, error);
    }
  });

  async function handleChatCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const channelId = interaction.channelId ?? "";

    if (interaction.commandName === "stats") {
      await interaction.reply(safeTruncate(config.onStats(channelId)));
      return;
    }

    if (interaction.commandName === "new") {
      const result = await config.onClear(channelId);
      await interaction.reply(safeTruncate(result));
      return;
    }

    if (interaction.commandName === "cost") {
      if (config.onCost) {
        await interaction.reply(safeTruncate(config.onCost(channelId)));
      }
      return;
    }

    if (interaction.commandName === "replay") {
      if (config.onReplay) {
        const result = config.onReplay(channelId);
        await interaction.reply(safeTruncate(result ?? "No digest found to replay."));
      }
      return;
    }

    if (interaction.commandName === "health") {
      if (config.onHealth) {
        await interaction.reply(safeTruncate(config.onHealth()));
      }
      return;
    }

    if (interaction.commandName === "digest") {
      if (config.onDigest) {
        await interaction.deferReply();
        const result = await config.onDigest(channelId);
        await interaction.editReply(safeTruncate(result));
      }
      return;
    }

    if (interaction.commandName === "refresh") {
      if (config.onRefresh) {
        await interaction.deferReply();
        const result = await config.onRefresh(channelId);
        await interaction.editReply(safeTruncate(result));
      }
      return;
    }

  }

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) {
      return;
    }

    if (
      !isAllowed(interaction.user.id, interaction.channelId ?? "", false, {
        allowedUserId: config.allowedUserId,
        allowedChannelIds: config.allowedChannelIds,
      })
    ) {
      return;
    }

    try {
      await handleChatCommand(interaction);
    } catch (error) {
      console.error(`[bot] /${interaction.commandName} failed:`, error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      const content = safeTruncate(`❌ ${errorMessage}`);

      try {
        if (interaction.deferred) {
          await interaction.editReply(content);
        } else if (interaction.replied) {
          await interaction.followUp(content);
        } else {
          await interaction.reply(content);
        }
      } catch (replyError) {
        console.error("[bot] Failed to report slash command error:", replyError);
      }
    }
  });

  return {
    client,
    login: () => client.login(config.token),
    async sendToChannel(channelId: string, text: string): Promise<void> {
      const channel = await client.channels.fetch(channelId);

      if (!isSendableChannel(channel)) {
        throw new Error(`Discord channel ${channelId} is not sendable`);
      }

      const chunks = splitMessage(text);
      for (const chunk of chunks) {
        await channel.send({
          content: chunk,
          allowedMentions: { parse: [] },
        });
      }
    },
    async requestConfirmation(channelId: string, preview: string, timeoutMs: number): Promise<boolean> {
      const channel = await client.channels.fetch(channelId);

      if (!isSendableChannel(channel)) {
        throw new Error(`Discord channel ${channelId} is not sendable`);
      }

      const msg = await (channel as SendableChannel).send({
        content: safeTruncate(`🦞 **Confirmation required:**\n${preview}\n\nReact ✅ to confirm, ❌ to cancel.`),
        allowedMentions: { parse: [] },
      });

      await msg.react("✅");
      await msg.react("❌");

      // Wait for the allowed user to react
      const filter = (reaction: { emoji: { name: string | null } }, user: { id: string }) => {
        return (reaction.emoji.name === "✅" || reaction.emoji.name === "❌") && user.id === config.allowedUserId;
      };

      try {
        const collected = await msg.awaitReactions({ filter, max: 1, time: timeoutMs });
        const firstReaction = collected.values().next().value;
        return firstReaction?.emoji?.name === "✅";
      } catch {
        // Timeout — treat as rejection
        return false;
      }
    },
  };
}
