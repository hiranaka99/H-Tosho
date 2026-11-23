import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reducer } from '../src/pages/downloader/useUnifiedSearch.js';

type State = Parameters<typeof reducer>[0];

const idle: State = {
  draft: 'artist:"mana"',
  committed: null,
  status: 'idle',
  entries: [],
  cursor: null,
  hasMore: false,
  loadedUniqueCount: 0,
  totalUnique: null,
  providers: [],
  error: null,
  retrying: null,
};

test('an aborted search that nothing replaced returns to idle instead of loading forever', () => {
  const searching = reducer(idle, { type: 'start', query: 'artist:"mana"' });
  assert.equal(searching.status, 'searching');
  const cancelled = reducer(searching, { type: 'cancel' });
  assert.equal(cancelled.status, 'idle');
  assert.equal(cancelled.committed, 'artist:"mana"', 'the query is kept so the restored search can start again');
  assert.equal(cancelled.error, null);
});

test('cancelling a retry or load-more keeps the delivered results', () => {
  const loaded = { ...idle, committed: 'x', entries: [{ entryId: 'e1' } as State['entries'][number]], cursor: 'c1', hasMore: true };
  const retrying = reducer(loaded, { type: 'retry', source: 'nhentai' });
  const cancelled = reducer(retrying, { type: 'cancel' });
  assert.equal(cancelled.status, 'idle');
  assert.equal(cancelled.retrying, null);
  assert.equal(cancelled.entries.length, 1);
  assert.equal(cancelled.cursor, 'c1');
});
