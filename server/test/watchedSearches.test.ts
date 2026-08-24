import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

// Point the DB at a throwaway directory before the service loads (it imports
// db/index.js at module level); diffSeenResults itself is pure.
process.env.HTOSHO_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'htosho-ws-'));

const { diffSeenResults } = await import('../src/services/watchedSearches.js');

describe('diffSeenResults', () => {
  it('seeds silently on the first run (no backlog ping)', () => {
    assert.deepEqual(diffSeenResults(true, ['a', 'b', 'c'], new Set()), []);
  });

  it('reports only ids not seen before', () => {
    const seen = new Set(['a', 'b']);
    assert.deepEqual(diffSeenResults(false, ['a', 'b', 'c', 'd'], seen), ['c', 'd']);
  });

  it('returns empty when nothing is new', () => {
    assert.deepEqual(diffSeenResults(false, ['a'], new Set(['a'])), []);
  });

  it('reports everything when a later run has no prior seen rows', () => {
    assert.deepEqual(diffSeenResults(false, ['a', 'b'], new Set()), ['a', 'b']);
  });
});
