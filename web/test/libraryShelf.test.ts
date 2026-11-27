import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SeriesRow } from '../src/lib/api';
import { filterLibraryRows, needsReview, normalizeStatusFilter, prepareLibraryRows } from '../src/lib/libraryShelf.js';

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
  assert.deepEqual(shelf.counts, { matched: 1, review: 0, unmatched: 2, failed: 1 });
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

const triage: SeriesRow[] = [
  { id: 10, name: 'Confident', status: 'matched', matchScore: 0.95 },
  { id: 11, name: 'Shaky', status: 'matched', matchScore: 0.62 },
  { id: 12, name: 'Accepted', status: 'matched', matchScore: 0.5, confirmed: true },
  { id: 13, name: 'Missing', status: 'unmatched' },
  { id: 14, name: 'Broken', status: 'failed' },
  { id: 15, name: 'Borderline', status: 'matched', matchScore: 0.8 },
];

test('statuses are mutually exclusive: shaky matches count as needs review, not matched', () => {
  const index = prepareLibraryRows(triage, 'name');
  assert.deepEqual(index.counts, { matched: 3, review: 1, unmatched: 1, failed: 1 });
  assert.deepEqual(filterLibraryRows(index, '', 'review', false).map(row => row.id), [11]);
  assert.deepEqual(filterLibraryRows(index, '', 'matched', false).map(row => row.id), [12, 15, 10]);
});

test('the review threshold comes from the caller and the legacy filter id still works', () => {
  assert.equal(needsReview(triage[5]!), false);
  assert.equal(needsReview(triage[5]!, 0.9), true);
  assert.equal(needsReview(triage[2]!), false);
  assert.equal(normalizeStatusFilter('low-score'), 'review');
  assert.equal(normalizeStatusFilter('nonsense'), 'all');
  const index = prepareLibraryRows(triage, 'name', 0.9);
  assert.deepEqual(filterLibraryRows(index, '', 'low-score', false).map(row => row.id).sort((a, b) => a - b), [11, 15]);
});

test('confidence sort lists failures, unmatched, then matches from least to most certain', () => {
  const order = filterLibraryRows(prepareLibraryRows(triage, 'confidence'), '', 'all', false).map(row => row.id);
  assert.deepEqual(order, [14, 13, 11, 15, 10, 12]);
});
