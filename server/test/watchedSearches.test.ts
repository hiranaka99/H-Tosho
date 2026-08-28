import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

// Point the DB at a throwaway directory before the service loads (it imports
// db/index.js at module level); diffSeenResults itself is pure.
process.env.HTOSHO_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'htosho-ws-'));

// Dynamic imports are required here: the DB module snapshots HTOSHO_DATA_DIR at module load.
const { diffSeenResults, addWatchedSearch, checkWatchedSearches, listWatchedSearches } = await import('../src/services/watchedSearches.js');
const { doujinProviders } = await import('../src/downloader/providers.js');
const originalHitomi = doujinProviders.hitomi;

// Stub the hitomi provider so the full check pipeline runs against fixture data.
let searchResults: { source: string; galleryId: string; title: string; tags: string[]; artists: string[]; url?: string; coverUrl?: string }[] = [];
doujinProviders.hitomi = {
  id: 'hitomi',
  name: 'Hitomi.la',
  color: '#ff5722',
  async getGallery() {
    throw new Error('not used');
  },
  async search() {
    return searchResults as never;
  },
};

const log = () => {};
after(() => {
  doujinProviders.hitomi = originalHitomi;
});
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

describe('lastResults persistence', () => {
  it('seeds an empty list on the first check and stores new results on later checks', async () => {
    const watch = addWatchedSearch('hitomi', 'artist:lastresults');
    searchResults = [
      { source: 'hitomi', galleryId: 'seed-1', title: 'Seed One', tags: [], artists: [], url: 'https://hitomi.la/g/1' },
      { source: 'hitomi', galleryId: 'seed-2', title: 'Seed Two', tags: [], artists: [] },
    ];

    // First check = seed run: stores an empty list, no reported results.
    const seed = await checkWatchedSearches(log);
    assert.equal(seed.newGalleries, 0);
    assert.deepEqual(listWatchedSearches().find((w) => w.id === watch.id)!.lastResults, []);

    // Second check finds one genuinely new gallery with title/url/cover.
    searchResults = [
      { source: 'hitomi', galleryId: 'seed-1', title: 'Seed One', tags: [], artists: [] },
      { source: 'hitomi', galleryId: 'seed-2', title: 'Seed Two', tags: [], artists: [] },
      { source: 'hitomi', galleryId: 'fresh-3', title: 'Fresh Three', tags: [], artists: [], url: 'https://hitomi.la/g/3', coverUrl: 'https://img.test/3.jpg' },
    ];
    const second = await checkWatchedSearches(log);
    assert.equal(second.newGalleries, 1);
    const afterSecond = listWatchedSearches().find((w) => w.id === watch.id)!;
    assert.deepEqual(afterSecond.lastResults, [
      { galleryId: 'fresh-3', title: 'Fresh Three', url: 'https://hitomi.la/g/3', coverUrl: 'https://img.test/3.jpg' },
    ]);

    // A quiet check keeps the previous finds visible until a check that
    // actually finds something replaces them.
    searchResults = searchResults.filter((r) => r.galleryId !== 'fresh-3');
    await checkWatchedSearches(log);
    assert.deepEqual(listWatchedSearches().find((w) => w.id === watch.id)!.lastResults, [
      { galleryId: 'fresh-3', title: 'Fresh Three', url: 'https://hitomi.la/g/3', coverUrl: 'https://img.test/3.jpg' },
    ]);

    // A check with a new find replaces the list.
    searchResults.push({ source: 'hitomi', galleryId: 'fresh-4', title: 'Fresh Four', tags: [], artists: [], url: 'https://hitomi.la/g/4' });
    await checkWatchedSearches(log);
    assert.deepEqual(listWatchedSearches().find((w) => w.id === watch.id)!.lastResults, [
      { galleryId: 'fresh-4', title: 'Fresh Four', url: 'https://hitomi.la/g/4' },
    ]);
  });
});
