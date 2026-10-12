import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SeriesRow } from '../src/lib/api';
import { filterLibraryRows, prepareLibraryRows } from '../src/lib/libraryShelf.js';

const rows: SeriesRow[] = [
  { id: 1, name: 'Moonlit Garden', artists: ['Sample Artist'], tags: ['Romance', 'Slice of Life'], status: 'matched', dateAdded: '2026-10-01' },
  { id: 2, name: 'Romance in the Title', artists: ['Other Artist'], tags: ['Adventure'], status: 'unmatched', dateAdded: '2026-10-02' },
  { id: 3, name: 'Quiet Days', tags: ['ROMANTIC COMEDY'], status: 'failed', dateAdded: '2026-10-03' },
  { id: 4, name: 'Legacy entry', status: 'unmatched' },
];
const shelf = prepareLibraryRows(rows, 'date-added');
const ids = (query: string, status = 'all') => filterLibraryRows(shelf, query, status, false).map(row => row.id);

test('library search matches saved tags case-insensitively along with titles and artists', () => {
  assert.deepEqual(ids('romance'), [2, 1]);
  assert.deepEqual(ids('  ROMAN  '), [3, 2, 1]);
  assert.deepEqual(ids('sample artist'), [1]);
  assert.deepEqual(ids('garden'), [1]);
});

test('tag-scoped queries ignore title and artist matches', () => {
  assert.deepEqual(ids('tag:romance'), [1]);
  assert.deepEqual(ids('tags:ROMAN'), [3, 1]);
  assert.deepEqual(ids('tag:sample artist'), []);
});

test('multiword tag queries support spaces, quotes and underscores', () => {
  for (const query of ['tag:slice of life', 'tag:"Slice of Life"', 'tag:slice_of_life']) assert.deepEqual(ids(query), [1]);
});

test('tag filters combine with match status and preserve ordering and totals', () => {
  assert.deepEqual(ids('tag:roman', 'matched'), [1]);
  assert.deepEqual(ids('tag:roman', 'failed'), [3]);
  assert.deepEqual(ids('tag:roman', 'unmatched'), []);
  assert.deepEqual(shelf.counts, { matched: 1, unmatched: 2, failed: 1 });
});

test('empty input and legacy rows without tags remain usable', () => {
  assert.deepEqual(ids(' '), [3, 2, 1, 4]);
  assert.deepEqual(ids('tag:'), [3, 2, 1, 4]);
  assert.deepEqual(ids('legacy'), [4]);
});

test('tag filtering includes results beyond the first displayed page', () => {
  const full = prepareLibraryRows(Array.from({ length: 85 }, (_, index) => ({ id: index, name: `Series ${index}`, status: 'unmatched', tags: index === 84 ? ['Rare Tag'] : [] })), 'name');
  assert.deepEqual(filterLibraryRows(full, 'tag:rare', 'all', false).map(row => row.id), [84]);
});
