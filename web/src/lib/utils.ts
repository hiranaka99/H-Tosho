import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import type { DoujinSource } from './api';

/** Merge Tailwind classes. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * Build a single-tag/artist search fragment from a details card, formatted for
 * the target source's query syntax. Hitomi uses bare underscored multi-word values
 * (e.g. `artist:charu_lee`); nHentai wraps values in quotes (e.g. `artist:"Charu Lee"`);
 * E-Hentai/ExHentai quotes namespace values (e.g. `artist:"charu lee"`).
 * An empty namespace yields a plain keyword search on the raw value.
 */
export function buildTagSearchFragment(value: string, ns: string | null | undefined, source: DoujinSource): string {
  const v = value.trim();
  if (!v) return '';
  if (source === 'nhentai') {
    return ns ? `${ns}:"${v}"` : `"${v}"`;
  }
  if (source === 'ehentai') {
    return ns ? `${ns}:"${v.replace(/"/g, '')}"` : v;
  }
  const underscored = v.replace(/\s+/g, '_');
  return ns ? `${ns}:${underscored}` : underscored;
}

/** Human-facing name for a source identifier, including non-doujin rows
 *  (e.g. `library` in duplicate matches). Unknown values pass through. */
export function sourceDisplayName(source: string): string {
  switch (source) {
    case 'hitomi': return 'Hitomi.la';
    case 'nhentai': return 'nHentai';
    case 'ehentai': return 'E-Hentai';
    case 'library': return 'Library';
    default: return source;
  }
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
  mangadex: '#f4c145',
  myanimelist: '#3b82f6',
};

export const PROVIDER_NAMES: Record<string, string> = {
  anilist: 'AniList',
  mangadex: 'MangaDex',
  myanimelist: 'MyAnimeList',
};

/** Human-facing names for background job types (raw types are snake_case). */
export const JOB_LABELS: Record<string, string> = {
  'scan-matchable': 'Find matchable galleries',
  'scan-downloaded': 'Find matches for downloaded gallery',
  'scan-new': 'Scan new series',
  'match-unmatched': 'Match unmatched',
  'match-library': 'Match library',
  'match-series': 'Match series',
  'sync-series': 'Sync series',
  'apply-series': 'Apply & Sync',
  'restore-metadata': 'Restore metadata',
  'clear-overrides': 'Clear overrides',
  'check-watched-searches': 'Check watched searches',
  'edit-comicinfo': 'Edit ComicInfo',
  'merge-series': 'Merge series',
  'delete-series': 'Delete series',
};

export function jobLabel(type: string, payload?: Record<string, unknown>): string {
  // A library-scoped scan is the "Refresh Kavita Library" button; the scheduled
  // auto-scan (no payload) keeps the generic name.
  if (type === 'scan-new' && payload?.libraryId !== undefined) return 'Refreshing Kavita Library';
  return JOB_LABELS[type] ?? type;
}

/** SQLite's `CURRENT_TIMESTAMP` default stores UTC as 'YYYY-MM-DD HH:MM:SS' (no Z).
 * JS parses that as local time; normalize to explicit UTC ISO before parsing. */
export function toIsoUtc(iso: string): string {
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(iso) ? iso.replace(' ', 'T') + 'Z' : iso;
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '—';
  const then = new Date(toIsoUtc(iso)).getTime();
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
  return new Date(toIsoUtc(iso)).toLocaleDateString();
}

export function shortDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(toIsoUtc(iso));
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 10);
}
