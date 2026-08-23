import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Merge Tailwind classes. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export type MatchStatus = 'matched' | 'unmatched' | 'syncing' | 'failed';

export const STATUS_LABEL: Record<MatchStatus, string> = {
  matched: 'Matched',
  unmatched: 'Unmatched',
  syncing: 'Syncing',
  failed: 'Failed',
};

/** Provider accent colors (mirrors backend provider.color). */
export const PROVIDER_COLORS: Record<string, string> = {
  anilist: '#02b968',
  mangaupdates: '#ff5555',
  mangadex: '#f4c145',
  myanimelist: '#3b82f6',
};

export const PROVIDER_NAMES: Record<string, string> = {
  anilist: 'AniList',
  mangaupdates: 'MangaUpdates',
  mangadex: 'MangaDex',
  myanimelist: 'MyAnimeList',
};

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const diff = Date.now() - then;
  const s = Math.floor(diff / 1000);
  if (s < 60) return s + 's ago';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  const d = Math.floor(h / 24);
  if (d < 30) return d + 'd ago';
  return new Date(iso).toLocaleDateString();
}

export function shortDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 10);
}

export function pct(part: number, whole: number): number {
  if (!whole) return 0;
  return Math.round((part / whole) * 100);
}