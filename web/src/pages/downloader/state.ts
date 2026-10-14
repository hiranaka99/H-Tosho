import type { DoujinSource, DoujinSort } from '../../lib/api';
import type { TranslationLink } from '../../lib/searchTranslation';

/** Source list fallback (rendered before the server's provider list resolves). */
export const FALLBACK_SOURCES: { id: DoujinSource; label: string }[] = [
  { id: 'hitomi', label: 'Hitomi.la' },
  { id: 'nhentai', label: 'nHentai' },
];

/** Display accent per doujin source (mirrors backend provider.color). */
export const SOURCE_COLORS: Record<DoujinSource, string> = {
  hitomi: '#ff5722',
  nhentai: '#e91e63' };

const DOWNLOADER_STATE_KEY = 'h-tosho:downloader-state';
export type DownloaderTab = 'search' | 'recommend' | 'watched' | 'manager';

export interface DownloaderStateCache {
  tab?: DownloaderTab;
  source?: DoujinSource;
  query?: string;
  searchKey?: string | null;
  sort?: DoujinSort;
  page?: number;
  searches?: Partial<Record<DoujinSource, { query: string; searchKey: string | null; sort: DoujinSort }>>;
  translation?: TranslationLink | null;
}

export function readDownloaderState(): DownloaderStateCache {
  try {
    return JSON.parse(sessionStorage.getItem(DOWNLOADER_STATE_KEY) ?? '{}') as DownloaderStateCache;
  } catch {
    return {};
  }
}

export function writeDownloaderState(update: Partial<DownloaderStateCache>) {
  sessionStorage.setItem(DOWNLOADER_STATE_KEY, JSON.stringify({ ...readDownloaderState(), ...update }));
}

/**
 * Result ordering options for nHentai searches, mirroring nhentai.net's own
 * sort controls.
 */
const NHENTAI_SORTS: { value: DoujinSort; label: string }[] = [
  { value: 'default', label: 'Newest' },
  { value: 'popular', label: 'Popular — all time' },
  { value: 'popular-week', label: 'Popular — this week' },
  { value: 'popular-today', label: 'Popular — today' },
];

/** Result ordering options for Hitomi searches (mirrors hitomi.la's sort dropdown). */
const HITOMI_SORTS: { value: DoujinSort; label: string }[] = [
  { value: 'default', label: 'Newest' },
  { value: 'date-published', label: 'Date published' },
  { value: 'random', label: 'Random' },
  { value: 'popular-today', label: 'Popular Today' },
  { value: 'popular-week', label: 'Popular Week' },
  { value: 'popular-month', label: 'Popular Month' },
  { value: 'popular-year', label: 'Popular Year' },
];

/** The sort options a source offers (sent as a separate field — the search box never shows the syntax). */
const DEFAULT_SORTS: { value: DoujinSort; label: string }[] = [{ value: 'default', label: 'Newest' }];
export const sortsFor = (src: DoujinSource): { value: DoujinSort; label: string }[] =>
  src === 'nhentai' ? NHENTAI_SORTS : src === 'hitomi' ? HITOMI_SORTS : DEFAULT_SORTS;

/** Human-facing display name for a doujin source. */
export const SOURCE_LABELS: Record<DoujinSource, string> = { hitomi: 'Hitomi.la', nhentai: 'nHentai' };

export type DownloadSetup = { status: 'loading' | 'error' | 'missing' | 'ready'; directory?: string; format?: 'cbz' | 'folder'; onRetry: () => void };
export const DOWNLOADER_SETTINGS_URL = '/settings?tab=downloader';
