import type { DoujinSource, DoujinSort } from "../../lib/api";
import type { TranslationLink } from "../../lib/searchTranslation";

/** Source list fallback (rendered before the server's provider list resolves). */
export const FALLBACK_SOURCES: { id: DoujinSource; label: string }[] = [
  { id: "hitomi", label: "Hitomi.la" },
  { id: "nhentai", label: "nHentai" },
  { id: "ehentai", label: "E-Hentai" },
];

/** Display accent per doujin source (mirrors backend provider.color). */
export const SOURCE_COLORS: Record<DoujinSource, string> = {
  hitomi: "#ff5722",
  nhentai: "#e91e63",
  ehentai: "#00a1d6",
};

const DOWNLOADER_STATE_KEY = "h-tosho:downloader-state";
export type DownloaderTab = "search" | "recommend" | "watched" | "manager";
/** Search scope: every source at once, or one provider with its own sort and Watch. */
export type SearchScope = "all" | DoujinSource;

export interface DownloaderStateCache {
  /** Older sessions may still hold the retired 'unified' tab id. */
  tab?: DownloaderTab | "unified";
  scope?: SearchScope;
  source?: DoujinSource;
  query?: string;
  searchKey?: string | null;
  sort?: DoujinSort;
  page?: number;
  searches?: Partial<
    Record<
      DoujinSource,
      { query: string; searchKey: string | null; sort: DoujinSort }
    >
  >;
  translation?: TranslationLink | null;
  /** Unified-search draft and committed query — isolated from native search
   *  state. Only non-sensitive text; dead server cursors are never persisted. */
  unifiedQuery?: string;
  unifiedSearchKey?: string | null;
}

export function readDownloaderState(): DownloaderStateCache {
  try {
    return JSON.parse(
      sessionStorage.getItem(DOWNLOADER_STATE_KEY) ?? "{}"
    ) as DownloaderStateCache;
  } catch {
    return {};
  }
}

export function writeDownloaderState(update: Partial<DownloaderStateCache>) {
  sessionStorage.setItem(
    DOWNLOADER_STATE_KEY,
    JSON.stringify({ ...readDownloaderState(), ...update })
  );
}

/**
 * Result ordering options for nHentai searches, mirroring nhentai.net's own
 * sort controls.
 */
const NHENTAI_SORTS: { value: DoujinSort; label: string }[] = [
  { value: "default", label: "Newest" },
  { value: "popular", label: "Popular — all time" },
  { value: "popular-week", label: "Popular — this week" },
  { value: "popular-today", label: "Popular — today" },
];

/** Result ordering options for Hitomi searches (mirrors hitomi.la's sort dropdown). */
const HITOMI_SORTS: { value: DoujinSort; label: string }[] = [
  { value: "default", label: "Newest" },
  { value: "date-published", label: "Date published" },
  { value: "random", label: "Random" },
  { value: "popular-today", label: "Popular — today" },
  { value: "popular-week", label: "Popular — this week" },
  { value: "popular-month", label: "Popular — this month" },
  { value: "popular-year", label: "Popular — this year" },
];

/** The sort options a source offers (sent as a separate field — the search box never shows the syntax). */
const DEFAULT_SORTS: { value: DoujinSort; label: string }[] = [
  { value: "default", label: "Newest" },
];
export const sortsFor = (
  src: DoujinSource
): { value: DoujinSort; label: string }[] =>
  src === "nhentai"
    ? NHENTAI_SORTS
    : src === "hitomi"
      ? HITOMI_SORTS
      : DEFAULT_SORTS;

/** Human-facing display name for a doujin source. */
export const SOURCE_LABELS: Record<DoujinSource, string> = {
  hitomi: "Hitomi.la",
  nhentai: "nHentai",
  ehentai: "E-Hentai",
};

export type DownloadSetup = {
  status: "loading" | "error" | "missing" | "ready";
  directory?: string;
  format?: "cbz" | "folder";
  onRetry: () => void;
};
export const DOWNLOADER_SETTINGS_URL = "/settings?tab=downloads";
/** Source accounts and keys (E-Hentai cookies, nHentai key) live under Settings → Sources. */
export const SOURCE_SETTINGS_URL = "/settings?tab=sources";
export const EHENTAI_ACCOUNT_SETTINGS_URL =
  "/settings?tab=sources#ehentai-account";
