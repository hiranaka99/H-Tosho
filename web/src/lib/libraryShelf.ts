import type { SeriesRow } from './api';

/** Fallback until the server reports its own threshold (`/series/low-confidence`). */
export const DEFAULT_REVIEW_THRESHOLD = 0.8;

export type LibrarySort = 'name' | 'date-added' | 'confidence';
/** Every row falls in exactly one bucket, so counts and filters always agree. */
export type LibraryBucket = 'matched' | 'review' | 'unmatched' | 'failed' | 'other';
export type LibraryStatusFilter = 'all' | Exclude<LibraryBucket, 'other'>;

export function needsReview(row: SeriesRow, threshold = DEFAULT_REVIEW_THRESHOLD): boolean {
  return row.status === 'matched' && !row.confirmed && typeof row.matchScore === 'number' && row.matchScore < threshold;
}

export function rowBucket(row: SeriesRow, threshold = DEFAULT_REVIEW_THRESHOLD): LibraryBucket {
  if (needsReview(row, threshold)) return 'review';
  if (row.status === 'matched' || row.status === 'unmatched' || row.status === 'failed') return row.status;
  return 'other';
}

/** Older sessions stored `low-score` for the review filter. */
export function normalizeStatusFilter(value: unknown): LibraryStatusFilter {
  if (value === 'low-score') return 'review';
  return value === 'matched' || value === 'review' || value === 'unmatched' || value === 'failed' ? value : 'all';
}

export function normalizeSort(value: unknown): LibrarySort {
  return value === 'name' || value === 'confidence' ? value : 'date-added';
}

/** Lower means less certain: failures, then unmatched, then matches by score. */
function confidence(row: SeriesRow): number {
  if (row.status === 'failed') return -2;
  if (row.status === 'unmatched') return -1;
  if (row.confirmed) return 1;
  return typeof row.matchScore === 'number' ? row.matchScore : 1;
}

/** Prepare once per library update or sort change, rather than on every keystroke. */
export function prepareLibraryRows(rows: readonly SeriesRow[], sortBy: LibrarySort, threshold = DEFAULT_REVIEW_THRESHOLD) {
  const ids = new Set<number>();
  const counts = { matched: 0, review: 0, unmatched: 0, failed: 0 };
  const entries = rows.map(row => {
    ids.add(row.id);
    const bucket = rowBucket(row, threshold);
    if (bucket in counts) counts[bucket as keyof typeof counts]++;
    return {
      row,
      bucket,
      name: row.name.toLowerCase(),
      artists: (row.artists ?? []).map(artist => artist.toLowerCase()),
      tags: (row.tags ?? []).map(tag => tag.toLowerCase()),
      dateAdded: Date.parse(row.dateAdded ?? '') || 0,
    };
  });
  // Unknown dates stay last; name ordering resolves equal dates consistently.
  const byName = (a: (typeof entries)[number], b: (typeof entries)[number]) => a.row.name.localeCompare(b.row.name);
  entries.sort(sortBy === 'date-added'
    ? (a, b) => b.dateAdded - a.dateAdded || byName(a, b)
    : sortBy === 'confidence'
      ? (a, b) => confidence(a.row) - confidence(b.row) || byName(a, b)
      : byName);
  return { entries, ids, counts };
}

export function librarySearchTerm(query: string) {
  const input = query.trim().toLowerCase();
  const tagQuery = /^tags?:\s*(.*)$/s.exec(input);
  const q = tagQuery ? tagQuery[1].replace(/^"|"$/g, '').replace(/_/g, ' ').trim() : input;
  return { q, tagsOnly: Boolean(tagQuery) };
}

export function filterLibraryRows(index: ReturnType<typeof prepareLibraryRows>, query: string, statusFilter: string, review: boolean): SeriesRow[] {
  const { q, tagsOnly } = librarySearchTerm(query);
  const status = normalizeStatusFilter(statusFilter);
  return index.entries.filter(({ bucket, name, artists, tags }) => {
    const okStatus = review || status === 'all' || bucket === status;
    return okStatus && (!q || tags.some(tag => tag.includes(q)) || !tagsOnly && (name.includes(q) || artists.some(artist => artist.includes(q))));
  }).map(entry => entry.row);
}
