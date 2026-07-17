export type SubmitResult = "accepted" | "queued" | "busy" | "rate_limited";

export interface ChannelSessionOptions {
  rateLimitMs: number;
  process: (text: string, channelId: string) => Promise<string>;
  deliver: (channelId: string, text: string) => Promise<void>;
  setTyping?: (channelId: string, active: boolean) => void;
}

interface ChannelState {
  inFlight: boolean;
  queuedText: string | null;
  lastAcceptedMessageAt: number;
}

export function createChannelSessions(options: ChannelSessionOptions): {
  submit(channelId: string, text: string): SubmitResult;
} {
  const channelStates = new Map<string, ChannelState>();

  function getChannelState(channelId: string): ChannelState {
    let state = channelStates.get(channelId);
    if (!state) {
      state = { inFlight: false, queuedText: null, lastAcceptedMessageAt: 0 };
      channelStates.set(channelId, state);
    }
    return state;
  }

  async function deliverError(channelId: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    try {
      await options.deliver(channelId, `❌ ${message}`);
    } catch (deliveryError) {
      console.error(`[channel] Failed to deliver error to ${channelId}:`, deliveryError);
    }
  }

  function beginTurn(channelId: string, text: string, state: ChannelState): void {
    state.inFlight = true;
    state.lastAcceptedMessageAt = Date.now();
    options.setTyping?.(channelId, true);

    void (async () => {
      try {
        const response = await options.process(text, channelId);
        await options.deliver(channelId, response);
      } catch (error) {
        await deliverError(channelId, error);
      } finally {
        options.setTyping?.(channelId, false);
        state.inFlight = false;

        if (state.queuedText !== null) {
          const queuedText = state.queuedText;
          state.queuedText = null;
          beginTurn(channelId, queuedText, state);
        }
      }
    })();
  }

  return {
    submit(channelId: string, text: string): SubmitResult {
      const state = getChannelState(channelId);

      if (state.inFlight) {
        if (state.queuedText !== null) return "busy";
        state.queuedText = text;
        return "queued";
      }

      if (Date.now() - state.lastAcceptedMessageAt < options.rateLimitMs) {
        return "rate_limited";
      }

      beginTurn(channelId, text, state);
      return "accepted";
    },
  };
}
