import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { eq, sql } from 'drizzle-orm';
import Database from 'better-sqlite3';

// Point the DB at a throwaway directory before the service loads (it imports
// db/index.js at module level); diffSeenResults itself is pure.
process.env.HTOSHO_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'htosho-ws-'));

// Start with a pre-page-count feed to exercise the upgrade without losing old finds.
const legacy = new Database(path.join(process.env.HTOSHO_DATA_DIR, 'htosho.db'));
legacy.exec(`
  CREATE TABLE watched_search_new (
    id INTEGER PRIMARY KEY, search_id INTEGER NOT NULL, source TEXT NOT NULL,
    query TEXT NOT NULL, gallery_id TEXT NOT NULL, title TEXT NOT NULL,
    url TEXT, cover_url TEXT, found_at TEXT NOT NULL
  );
  INSERT INTO watched_search_new (search_id, source, query, gallery_id, title, found_at)
    VALUES (999, 'hitomi', 'legacy', 'old-find', 'Old Find', '2026-01-01T00:00:00.000Z');
`);
legacy.close();

// Dynamic imports are required here: the DB module snapshots HTOSHO_DATA_DIR at module load.
const { diffSeenResults, addWatchedSearch, checkWatchedSearches, listWatchedSearches } = await import('../src/services/watchedSearches.js');
const { doujinProviders } = await import('../src/downloader/providers.js');
const { listNewGalleries, removeWatchedSearch, backfillNewGalleries } = await import('../src/services/watchedSearches.js');
const { getDb, schema } = await import('../src/db/index.js');
const originalHitomi = doujinProviders.hitomi;

// Stub the hitomi provider so the full check pipeline runs against fixture data.
let searchResults: { source: string; galleryId: string; title: string; tags: string[]; artists: string[]; url?: string; coverUrl?: string; pageCount?: number }[] = [];
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
      { source: 'hitomi', galleryId: 'fresh-3', title: 'Fresh Three', tags: [], artists: [], url: 'https://hitomi.la/g/3', coverUrl: 'https://img.test/3.jpg', pageCount: 24 },
    ];
    const second = await checkWatchedSearches(log);
    assert.equal(second.newGalleries, 1);
    const afterSecond = listWatchedSearches().find((w) => w.id === watch.id)!;
    assert.deepEqual(afterSecond.lastResults, [
      { galleryId: 'fresh-3', title: 'Fresh Three', url: 'https://hitomi.la/g/3', coverUrl: 'https://img.test/3.jpg', pageCount: 24 },
    ]);

    // A quiet check keeps the previous finds visible until a check that
    // actually finds something replaces them.
    searchResults = searchResults.filter((r) => r.galleryId !== 'fresh-3');
    await checkWatchedSearches(log);
    assert.deepEqual(listWatchedSearches().find((w) => w.id === watch.id)!.lastResults, [
      { galleryId: 'fresh-3', title: 'Fresh Three', url: 'https://hitomi.la/g/3', coverUrl: 'https://img.test/3.jpg', pageCount: 24 },
    ]);

    // A check with a new find replaces the list.
    searchResults.push({ source: 'hitomi', galleryId: 'fresh-4', title: 'Fresh Four', tags: [], artists: [], url: 'https://hitomi.la/g/4' });
    await checkWatchedSearches(log);
    assert.deepEqual(listWatchedSearches().find((w) => w.id === watch.id)!.lastResults, [
      { galleryId: 'fresh-4', title: 'Fresh Four', url: 'https://hitomi.la/g/4' },
    ]);
  });

  it('omits unknown and invalid counts when decoding saved results', () => {
    const watch = addWatchedSearch('hitomi', 'artist:page-count-validation');
    const counts = [undefined, null, 0, -1, 1.5, '24', 24];
    getDb().update(schema.watchedSearches)
      .set({ lastResultsJson: JSON.stringify(counts.map((pageCount, i) => ({ galleryId: String(i), title: 'Count', pageCount }))) })
      .where(eq(schema.watchedSearches.id, watch.id)).run();
    const results = listWatchedSearches().find((w) => w.id === watch.id)!.lastResults;
    assert.deepEqual(results.map((r) => r.pageCount), [undefined, undefined, undefined, undefined, undefined, undefined, 24]);
    removeWatchedSearch(watch.id);
  });
});

describe('recently added feed', () => {
  const FEED_QUERY = 'artist:feedtest';
  /** Feed rows for this describe's watch only — earlier tests leave their own rows behind. */
  const myFeed = (limit = 500) => listNewGalleries(limit).filter((g) => g.query === FEED_QUERY);

  it('keeps legacy feed entries readable after adding the page-count column', () => {
    const old = listNewGalleries(500).find((g) => g.galleryId === 'old-find');
    assert.ok(old);
    assert.equal(old.title, 'Old Find');
    assert.equal(old.pageCount, undefined);
  });

  it('persists new finds with metadata and lists them newest-first', async () => {
    addWatchedSearch('hitomi', FEED_QUERY);
    searchResults = [
      { source: 'hitomi', galleryId: 'f-1', title: 'Feed One', tags: [], artists: [] },
    ];
    await checkWatchedSearches(log); // seed run — nothing lands in the feed
    assert.equal(myFeed().length, 0);

    searchResults = [
      { source: 'hitomi', galleryId: 'f-1', title: 'Feed One', tags: [], artists: [] },
      { source: 'hitomi', galleryId: 'f-2', title: 'Feed Two', tags: [], artists: [], url: 'https://hitomi.la/g/2', coverUrl: 'https://img.test/2.jpg', pageCount: 32 },
    ];
    const res = await checkWatchedSearches(log);
    assert.equal(res.newGalleries >= 1, true);
    const [only] = myFeed();
    assert.ok(only, 'expected the new find in the feed');
    assert.equal(only.source, 'hitomi');
    assert.equal(only.galleryId, 'f-2');
    assert.equal(only.title, 'Feed Two');
    assert.equal(only.url, 'https://hitomi.la/g/2');
    assert.equal(only.coverUrl, 'https://img.test/2.jpg');
    assert.equal(only.pageCount, 32);
    assert.equal(only.query, FEED_QUERY);
    assert.ok(!Number.isNaN(Date.parse(only.foundAt)), 'foundAt must be parseable ISO 8601');

    // A later find sorts above the earlier one.
    searchResults.push({ source: 'hitomi', galleryId: 'f-3', title: 'Feed Three', tags: [], artists: [] });
    await checkWatchedSearches(log);
    assert.deepEqual(myFeed().map((g) => g.galleryId), ['f-3', 'f-2']);
    assert.equal(myFeed()[0].pageCount, undefined, 'unknown counts remain absent');
  });

  it('dedupes a gallery found by several watches and honors the limit', async () => {
    const watchB = addWatchedSearch('hitomi', 'artist:feedtest-b');
    searchResults = [
      { source: 'hitomi', galleryId: 'shared-9', title: 'Shared Nine', tags: [], artists: [] },
    ];
    await checkWatchedSearches(log); // watch B seeds; the other watches report shared-9 as new

    searchResults = [
      { source: 'hitomi', galleryId: 'f-4', title: 'Feed Four', tags: [], artists: [] },
      { source: 'hitomi', galleryId: 'shared-9', title: 'Shared Nine', tags: [], artists: [] },
    ];
    await checkWatchedSearches(log); // f-4 is new for every non-seeded watch

    const rawForF4 = getDb()
      .select({ n: sql<number>`count(*)` })
      .from(schema.watchedSearchNew)
      .where(eq(schema.watchedSearchNew.galleryId, 'f-4'))
      .get();
    assert.ok(Number(rawForF4?.n ?? 0) >= 2, 'expected one row per discovering watch');

    const feed = listNewGalleries(500);
    assert.equal(feed.filter((g) => g.galleryId === 'f-4').length, 1, 'feed must dedupe across watches');
    assert.equal(feed[0].galleryId, 'f-4', 'newest find comes first');
    assert.deepEqual(listNewGalleries(1).map((g) => g.galleryId), ['f-4'], 'limit caps the feed');

    // Removing a watch drops its feed rows (table level: other watches also
    // reported f-4, so it stays in the feed via them).
    assert.equal(removeWatchedSearch(watchB.id), true);
    const rowsForB = getDb()
      .select({ n: sql<number>`count(*)` })
      .from(schema.watchedSearchNew)
      .where(eq(schema.watchedSearchNew.searchId, watchB.id))
      .get();
    assert.equal(Number(rowsForB?.n ?? 0), 0);
  });

  it('backfills lastResults written by older builds into the feed exactly once', async () => {
    const watch = addWatchedSearch('hitomi', 'artist:legacy-backfill');
    // Simulate a pre-feature build: the "N new" list is persisted, but no
    // watched_search_new rows exist for it.
    getDb()
      .update(schema.watchedSearches)
      .set({ lastCheckedAt: '2026-08-30T09:00:00.000Z', lastResultCount: 1, lastResultsJson: JSON.stringify([{ galleryId: 'legacy-7', title: 'Legacy Seven', url: 'https://hitomi.la/g/7', pageCount: 18 }]) })
      .where(eq(schema.watchedSearches.id, watch.id))
      .run();

    const inserted = backfillNewGalleries();
    assert.ok(inserted >= 1, 'expected the legacy find to be replayed');
    const feed = listNewGalleries(500).filter((g) => g.query === 'artist:legacy-backfill');
    assert.equal(feed.length, 1);
    assert.equal(feed[0].galleryId, 'legacy-7');
    assert.equal(feed[0].title, 'Legacy Seven');
    assert.equal(feed[0].pageCount, 18);
    assert.equal(feed[0].foundAt, '2026-08-30T09:00:00.000Z', 'backfilled rows keep the reporting check\'s timestamp');

    // Re-running (every startup) is a no-op — the unique index dedupes.
    backfillNewGalleries();
    const count = getDb()
      .select({ n: sql<number>`count(*)` })
      .from(schema.watchedSearchNew)
      .where(eq(schema.watchedSearchNew.galleryId, 'legacy-7'))
      .get();
    assert.equal(Number(count?.n ?? 0), 1);
  });
});
