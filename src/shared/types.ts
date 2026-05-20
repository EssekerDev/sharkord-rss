// Shared constants keep the server and the persisted settings value aligned.
export const DEFAULT_INTERVAL_MINUTES = 15;
export const MIN_INTERVAL_MINUTES = 1;

// Persisted feed configuration. Sharkord channel IDs are numeric in the local SDK.
// `bootstrappedAt` is set after the first successful bootstrap so plugin reloads
// no longer re-post the initial articles when `postOnBootstrap` stays enabled.
export interface FeedConfig {
  url: string;
  channelId: number;
  intervalMinutes: number;
  postOnBootstrap?: boolean;
  bootstrappedAt?: number;
}

// Runtime-only fields tracked in memory for scheduling, backoff, and diagnostics.
export interface FeedStatus extends FeedConfig {
  lastPolledAt: number | null;
  articlesPosted: number;
  errorCount: number;
  nextPollAt: number | null;
  backoffUntil: number | null;
  backoffDelayMinutes: number | null;
}
