import type { FeedConfig } from './shared/types';

/** What the admin tab shows for one configured feed. */
export type TFeedView = FeedConfig & {
  lastPolledAt: number | null;
  articlesPosted: number;
  errorCount: number;
  backoffUntil: number | null;
  backoffDelayMinutes: number | null;
};

/** Payload used to create or update a feed from the admin tab. */
export type TSaveFeed = {
  url: string;
  channelId: number;
  intervalMinutes?: number;
  postOnBootstrap?: boolean;
};

/**
 * Contract shared by the server and the admin tab. Actions are admin-only
 * (`MANAGE_PLUGINS`) and re-checked inside each handler.
 */
export type TPlugin = {
  actions: {
    list: { payload: Record<string, never>; response: TFeedView[] };
    create: { payload: TSaveFeed; response: TFeedView[] };
    update: { payload: TSaveFeed & { previousUrl: string }; response: TFeedView[] };
    remove: { payload: { url: string }; response: TFeedView[] };
  };
};
