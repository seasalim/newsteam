import type { ChannelProvider, SwarmConfig } from "./config-types.ts";
import { requireEnum, requireObject, requireString } from "./config-validators.ts";

export function validateChannelSelection(
  channelValue: unknown,
  discordValue: unknown,
): Pick<SwarmConfig, "channel" | "discord"> {
  const provider = channelValue === undefined
    ? "discord"
    : requireEnum(
      requireObject(channelValue, "config.channel").provider,
      "config.channel.provider",
      new Set<ChannelProvider>(["discord", "local"]),
    ) as ChannelProvider;

  if (provider === "local") {
    return { channel: { provider }, discord: undefined };
  }

  const discord = requireObject(discordValue, "config.discord");
  return {
    channel: { provider },
    discord: {
      allowed_user_id: requireString(discord.allowed_user_id, "config.discord.allowed_user_id"),
    },
  };
}
