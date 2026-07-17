export interface ChannelCallbacks {
  onMessage: (message: string, channelId: string) => Promise<string>;
  onStats: (channelId: string) => string;
  onClear: (channelId: string) => string | Promise<string>;
  onCost?: (channelId: string) => string;
  onReplay?: (channelId: string) => string | null;
  onHealth?: () => string;
  onDigest?: (channelId: string) => Promise<string>;
  onRefresh?: (channelId: string) => Promise<string>;
}

export interface ChannelAdapter {
  start(): Promise<void>;
  sendToChannel(channelId: string, text: string): Promise<void>;
  requestConfirmation(
    channelId: string,
    preview: string,
    timeoutMs: number,
  ): Promise<boolean>;
  stop(): Promise<void>;
}
