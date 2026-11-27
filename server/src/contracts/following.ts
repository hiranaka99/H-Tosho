import type { DoujinSource } from "./doujin.js";
export const NOTIFICATION_MODES = ["in-app", "immediate"] as const;
export type NotificationMode = (typeof NOTIFICATION_MODES)[number];

/** One cadence list for the global default and per-watch overrides. */
export const FOLLOWING_INTERVAL_MINUTES = [
  5, 15, 30, 60, 180, 360, 720, 1440,
] as const;
export type FollowingInterval = (typeof FOLLOWING_INTERVAL_MINUTES)[number];
export const FOLLOWING_SEARCH_LIMIT = 50;
export const FOLLOWING_TARGET_LIMIT = 100;

export interface CheckWatchedSearchesCommand {
  mode?: "manual" | "due";
  watchIds?: number[];
}

export interface WatchedSearchResultItem {
  galleryId: string;
  title: string;
  url?: string;
  coverUrl?: string;
  pageCount?: number;
}

export interface WatchedSearch {
  id: number;
  source: DoujinSource;
  query: string;
  displayName: string | null;
  folderId: number | null;
  pausedAt: string | null;
  intervalMinutes: FollowingInterval | null;
  notificationMode: NotificationMode;
  effectiveIntervalMinutes: number;
  nextCheckAt: string | null;
  revision: number;
  coverageLimit: number;
  lastCheckedAt: string | null;
  lastResultCount: number | null;
  seenCount: number;
  lastNewCount: number | null;
  lastFindsAt: string | null;
  lastAttemptedAt: string | null;
  lastFailedAt: string | null;
  lastError: string | null;
  lastResults: WatchedSearchResultItem[];
}

export interface WatchedSearchPatch {
  expectedRevision: number;
  displayName?: string | null;
  folderId?: number | null;
  paused?: boolean;
  intervalMinutes?: FollowingInterval | null;
  notificationMode?: NotificationMode;
}

export interface WatchedSearchFolder {
  id: number;
  name: string;
  position: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface WatchedSearchFolderPatch {
  expectedRevision: number;
  name?: string;
  position?: number;
}

export interface WatchedNewGallery {
  source: DoujinSource;
  galleryId: string;
  title: string;
  url?: string;
  coverUrl?: string;
  pageCount?: number;
  query: string;
  watchLabel: string;
  watchRemoved: boolean;
  foundAt: string;
  searchId: number;
  artists: string[];
  language?: string;
  reviewedAt: string | null;
  /** Owned copy this find is an uncensored/decensored edition of, checked when it was found. */
  betterEditionOf?: { title: string };
}

export interface WatchedGalleryFeed {
  items: WatchedNewGallery[];
  total: number;
  inboxCount: number;
  historyCount: number;
  /** Unreviewed finds that are better editions of owned galleries (same filters). */
  betterEditionCount: number;
  watches: {
    id: number;
    query: string;
    source: DoujinSource;
    watchLabel: string;
    folderId: number | null;
    removed: boolean;
  }[];
}

export interface FollowingFeedOptions {
  view?: "inbox" | "history";
  source?: string;
  searchId?: number;
  folderId?: number | "unfiled";
  offset?: number;
  limit?: number;
}

export function effectiveFollowingInterval(
  globalMinutes: number,
  pausedAt: string | null,
  intervalMinutes: FollowingInterval | null
): number {
  return globalMinutes === 0 || pausedAt !== null
    ? 0
    : (intervalMinutes ?? globalMinutes);
}

/** An artist the user collects but does not follow yet, with the evidence behind the suggestion. */
export interface SuggestedFollow {
  artist: string;
  /** Source the watch would run on: where most of this artist's galleries came from. */
  source: DoujinSource;
  /** The watch query compiled for that source. */
  query: string;
  /** Downloaded galleries credited to this artist. */
  downloads: number;
  /** Recommendation picks marked More like this. */
  liked: number;
  /** A few downloaded titles, for recognition. */
  titles: string[];
  lastDownloadedAt: string | null;
}
