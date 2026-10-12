import type { SeriesRow } from './api';

export function needsReview(row: SeriesRow): boolean {
  return row.status === 'matched' && !row.confirmed && typeof row.matchScore === 'number' && row.matchScore < 0.8;
}

/** Prepare once per library update or sort change, rather than on every keystroke. */
export function prepareLibraryRows(rows: readonly SeriesRow[], sortBy: 'name' | 'date-added') {
  const ids = new Set<number>();
  const counts = { matched: 0, unmatched: 0, failed: 0 };
  const entries = rows.map(row => {
    ids.add(row.id);
    if (row.status in counts) counts[row.status as keyof typeof counts]++;
    return {
      row,
      name: row.name.toLowerCase(),
      artists: (row.artists ?? []).map(artist => artist.toLowerCase()),
      tags: (row.tags ?? []).map(tag => tag.toLowerCase()),
      dateAdded: Date.parse(row.dateAdded ?? '') || 0,
    };
  });
  // Unknown dates stay last; name ordering resolves equal dates consistently.
  entries.sort(sortBy === 'date-added'
    ? (a, b) => b.dateAdded - a.dateAdded || a.row.name.localeCompare(b.row.name)
    : (a, b) => a.row.name.localeCompare(b.row.name));
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
  return index.entries.filter(({ row, name, artists, tags }) => {
    const okStatus = review || statusFilter === 'all'
      ? true
      : statusFilter === 'low-score' ? needsReview(row) : row.status === statusFilter;
    return okStatus && (!q || tags.some(tag => tag.includes(q)) || !tagsOnly && (name.includes(q) || artists.some(artist => artist.includes(q))));
  }).map(entry => entry.row);
}
