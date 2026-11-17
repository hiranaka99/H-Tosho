import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it, type TestContext } from 'node:test';
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
const { diffSeenResults, addWatchedSearch, checkWatchedSearches, listWatchedSearches, isStaleUpload } = await import('../src/services/watchedSearches.js');
const { doujinProviders } = await import('../src/downloader/providers.js');
const { listNewGalleries, removeWatchedSearch, backfillNewGalleries, listGalleryFeed, setGalleriesReviewed } = await import('../src/services/watchedSearches.js');
const { getDb, schema } = await import('../src/db/index.js');
const { getNotificationSettings, setNotificationSettings } = await import('../src/services/settings.js');
const { dispatchFollowingDeliveries, listFollowingDeliveries } = await import('../src/services/followingDelivery.js');
const originalHitomi = doujinProviders.hitomi;

// Stub the hitomi provider so the full check pipeline runs against fixture data.
let searchResults: { source: string; galleryId: string; title: string; tags: string[]; artists: string[]; language?: string; url?: string; coverUrl?: string; pageCount?: number; uploadedAt?: string }[] = [];
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
    removeWatchedSearch(watch.id, watch.revision);
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

    // Removing a watch stops monitoring but retains its discoveries in history.
    assert.equal(removeWatchedSearch(watchB.id, watchB.revision), true);
    const rowsForB = getDb()
      .select({ n: sql<number>`count(*)` })
      .from(schema.watchedSearchNew)
      .where(eq(schema.watchedSearchNew.searchId, watchB.id))
      .get();
    assert.ok(Number(rowsForB?.n ?? 0) > 0, "Stopping a watch preserves history");
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

describe('stale upload suppression (provider index hiccup)', () => {
  const STALE_QUERY = 'artist:stalegate';
  const DAY_MS = 24 * 60 * 60 * 1000;
  const daysAgo = (n: number, now = Date.now()) => new Date(now - n * DAY_MS).toISOString();

  function captureDiscord(t: TestContext) {
    const settings = getNotificationSettings();
    t.after(() => setNotificationSettings(settings));
    setNotificationSettings({ discord: { enabled: true, webhookUrl: 'https://discord.com/api/webhooks/test' } });
    const embeds: { description: string; thumbnail?: { url: string } }[] = [];
    t.mock.method(globalThis, 'fetch', async (_input: unknown, init?: RequestInit) => {
      embeds.push(...JSON.parse(String(init?.body)).embeds);
      return Response.json({ id: 'fixture-receipt' });
    });
    return embeds;
  }

  it('classifies by upload age and fails open on unknown dates', () => {
    const now = Date.now();
    assert.equal(isStaleUpload(undefined, now), false);
    assert.equal(isStaleUpload('', now), false);
    assert.equal(isStaleUpload('not-a-date', now), false);
    assert.equal(isStaleUpload(daysAgo(-1, now), now), false, 'future uploads are not stale');
    assert.equal(isStaleUpload(daysAgo(1, now), now), false);
    assert.equal(isStaleUpload(daysAgo(14, now), now), false, 'exactly at the threshold is not stale');
    assert.equal(isStaleUpload(new Date(now - 14 * DAY_MS - 1).toISOString(), now), true);
    assert.equal(isStaleUpload(new Date(now - 14 * DAY_MS + 1).toISOString(), now), false);
    assert.equal(isStaleUpload(daysAgo(15, now), now), true);
  });

  it('suppresses old "new" results from pings and feeds but remembers them as seen', async (t) => {
    const embeds = captureDiscord(t);
    const watch = addWatchedSearch('hitomi', STALE_QUERY);
    searchResults = [
      { source: 'hitomi', galleryId: 's-seed', title: 'Seed', tags: [], artists: [] },
    ];
    await checkWatchedSearches(log); // seed run
    assert.equal(embeds.some((e) => e.description.includes(STALE_QUERY)), false, 'seed runs never ping');
    embeds.length = 0;

    // The provider window now holds one fresh upload plus two old galleries that
    // re-entered the top-N — the shape of a mid-rebuild index hiccup.
    searchResults = [
      { source: 'hitomi', galleryId: 's-old-1', title: 'Old One', tags: [], artists: [], uploadedAt: daysAgo(400), coverUrl: 'https://img.test/old.jpg' },
      { source: 'hitomi', galleryId: 's-fresh', title: 'Fresh', tags: [], artists: [], uploadedAt: daysAgo(1), url: 'https://hitomi.la/g/fresh', coverUrl: 'https://img.test/fresh.jpg' },
      { source: 'hitomi', galleryId: 's-old-2', title: 'Old Two', tags: [], artists: [], uploadedAt: daysAgo(2000) },
    ];
    const messages: string[] = [];
    const checked = await checkWatchedSearches((_level, message) => messages.push(message));
    assert.equal(checked.notified, 0, 'provider checks never claim committed intents were sent');
    await dispatchFollowingDeliveries(Date.now() + 3_000);
    assert.equal(checked.newGalleries, checked.checked, 'each seeded watch finds only one fresh gallery');
    const [embed] = embeds.filter(e => e.description.includes('Fresh'));
    assert.ok(embed, 'expected a separate committed delivery for the fresh find');
    assert.match(embed.description, /^1 new gallery/);
    assert.ok(embed.description.includes('[Fresh](https://hitomi.la/g/fresh)'));
    assert.doesNotMatch(embed.description, /Old One|Old Two/);
    const delivered = listFollowingDeliveries({ status: 'delivered', limit: 100 }).items.find(item => item.members.some(member => member.galleryId === 's-fresh'));
    assert.ok(delivered?.members[0].labels.includes(STALE_QUERY));
    assert.ok(messages.some((m) => m.includes(STALE_QUERY) && m.includes('suppressed 2')));

    // The per-watch "new since last check" list holds only the fresh find.
    assert.deepEqual(
      listWatchedSearches().find((w) => w.id === watch.id)!.lastResults.map((r) => r.galleryId),
      ['s-fresh'],
    );

    // The Recently added feed gets no rows for the stale galleries.
    const feed = listNewGalleries(500).filter((g) => g.query === STALE_QUERY);
    assert.deepEqual(feed.map((g) => g.galleryId), ['s-fresh']);

    // All three are remembered as seen, so a settled index does not re-report them.
    const seen = getDb()
      .select({ galleryId: schema.watchedSearchSeen.galleryId })
      .from(schema.watchedSearchSeen)
      .where(eq(schema.watchedSearchSeen.searchId, watch.id))
      .all()
      .map((r) => r.galleryId);
    assert.deepEqual(seen.sort(), ['s-fresh', 's-old-1', 's-old-2', 's-seed']);

    // The next check over the same window reports nothing new.
    const again = await checkWatchedSearches(log);
    assert.equal(again.newGalleries, 0);
    assert.equal(again.notified, 0);

    // A later stale-only batch stays silent and preserves previous fresh finds.
    embeds.length = 0;
    searchResults = [
      { source: 'hitomi', galleryId: 's-old-3', title: 'Old Three', tags: [], artists: [], uploadedAt: daysAgo(30) },
    ];
    const staleOnly = await checkWatchedSearches(log);
    assert.equal(staleOnly.newGalleries, 0);
    assert.equal(staleOnly.notified, 0);
    assert.deepEqual(embeds, []);
    assert.deepEqual(listWatchedSearches().find((w) => w.id === watch.id)!.lastResults.map((r) => r.galleryId), ['s-fresh']);
    assert.deepEqual(listNewGalleries(500).filter((g) => g.query === STALE_QUERY).map((g) => g.galleryId), ['s-fresh']);
    assert.ok(getDb().select().from(schema.watchedSearchSeen)
      .where(eq(schema.watchedSearchSeen.searchId, watch.id)).all().some((r) => r.galleryId === 's-old-3'));
    removeWatchedSearch(watch.id, watch.revision);
  });

  it('reports missing, invalid, and future upload dates through notifications and feeds', async (t) => {
    const embeds = captureDiscord(t);
    const query = 'artist:unknown-upload';
    const watch = addWatchedSearch('hitomi', query);
    searchResults = [];
    await checkWatchedSearches(log);
    embeds.length = 0;
    searchResults = [
      { source: 'hitomi', galleryId: 'u-missing', title: 'Missing Date', tags: [], artists: [] },
      { source: 'hitomi', galleryId: 'u-invalid', title: 'Invalid Date', tags: [], artists: [], uploadedAt: 'not-a-date' },
      { source: 'hitomi', galleryId: 'u-future', title: 'Future Date', tags: [], artists: [], uploadedAt: daysAgo(-1) },
    ];
    await checkWatchedSearches(log);
    await dispatchFollowingDeliveries(Date.now() + 3_000);
    const descriptions = embeds.map(embed => embed.description).join('\n');
    for (const r of searchResults) assert.ok(descriptions.includes(r.title));
    assert.equal(listFollowingDeliveries({ status: 'delivered', limit: 100 }).items.filter(item => item.members.some(member => member.galleryId.startsWith('u-'))).length, 3);
    assert.deepEqual(listWatchedSearches().find((w) => w.id === watch.id)!.lastResults.map((r) => r.galleryId), searchResults.map((r) => r.galleryId));
    assert.deepEqual(listNewGalleries(500).filter((g) => g.query === query).map((g) => g.galleryId).sort(), searchResults.map((r) => r.galleryId).sort());
    removeWatchedSearch(watch.id, watch.revision);
  });
});


describe('watched inbox and history', () => {
  it('upgrades old discoveries with empty metadata and an unreviewed state', () => {
    const old = listNewGalleries(1000).find(item => item.galleryId === 'old-find')!;
    assert.deepEqual(old.artists, []);
    assert.equal(old.reviewedAt, null);
    assert.equal(old.language, undefined);
  });

  it('preserves artists/language and separates the last quiet check from retained finds', async () => {
    const watch = addWatchedSearch('hitomi', 'artist:metadata-inbox');
    searchResults = [];
    await checkWatchedSearches(log);
    searchResults = [{ source: 'hitomi', galleryId: 'metadata-find', title: 'Metadata Find', artists: ['Akatsuki Myuuto'], language: 'Japanese', tags: [], pageCount: 42 }];
    await checkWatchedSearches(log);
    const before = listWatchedSearches().find(item => item.id === watch.id)!;
    assert.equal(before.lastNewCount, 1);
    assert.ok(before.lastFindsAt);
    const feed = listGalleryFeed({ searchId: watch.id });
    assert.deepEqual(feed.items[0].artists, ['Akatsuki Myuuto']);
    assert.equal(feed.items[0].language, 'Japanese');
    await checkWatchedSearches(log);
    const after = listWatchedSearches().find(item => item.id === watch.id)!;
    assert.equal(after.lastNewCount, 0);
    assert.equal(after.lastFindsAt, before.lastFindsAt);
    assert.equal(after.lastResults.length, 1);
  });

  it('filters before deduplicating and paging, and shares review state across watches', () => {
    const table = schema.watchedSearchNew;
    const rows = Array.from({ length: 17 }, (_,i) => ({ searchId: 90001, source: 'hitomi', query: 'artist:filter', galleryId: `filter-${i}`, title: `Filter ${i}`, foundAt: new Date(Date.UTC(2026,9,1,0,i)).toISOString() }));
    getDb().insert(table).values([...rows, { ...rows[16], searchId: 90002, query: 'tag:other', foundAt: '2026-10-02T00:00:00Z' }, { ...rows[0], searchId: 90003, source: 'nhentai', galleryId: 'filter-16' }]).run();
    assert.equal(listGalleryFeed({ searchId: 90001, limit: 12 }).total, 17);
    assert.equal(listGalleryFeed({ searchId: 90001, offset: 12, limit: 12 }).items.length, 5);
    assert.equal(listGalleryFeed({ searchId: 90001 }).items[0].searchId, 90001, 'A later find by a different watch must not remove the match');
    assert.equal(setGalleriesReviewed([{ source: 'hitomi', galleryId: 'filter-16' }], true), true);
    assert.equal(listGalleryFeed({ searchId: 90001, view: 'inbox' }).total, 16);
    assert.equal(listGalleryFeed({ searchId: 90002, view: 'inbox' }).total, 0);
    assert.equal(listGalleryFeed({ searchId: 90001, view: 'history' }).total, 17);
    assert.ok(listGalleryFeed({ searchId: 90002, view: 'history' }).items[0].reviewedAt);
    assert.equal(listGalleryFeed({ searchId: 90003, source: 'nhentai', view: 'inbox' }).total, 1, 'Provider identities remain distinct');
    assert.equal(setGalleriesReviewed([{ source: 'hitomi', galleryId: 'filter-16' }], false), true);
    assert.equal(listGalleryFeed({ searchId: 90002, view: 'inbox' }).total, 1);
    assert.equal(setGalleriesReviewed([{ source: 'hitomi', galleryId: 'filter-16' }, { source: 'hitomi', galleryId: 'missing' }], true), false);
    assert.equal(listGalleryFeed({ searchId: 90002, view: 'inbox' }).total, 1, 'Failed batches must not partially mark reviewed');
  });

  it('retains reviewed state when another watch discovers the gallery later', async () => {
    const first = addWatchedSearch('hitomi', 'artist:review-origin');
    searchResults = [];
    await checkWatchedSearches(log);
    searchResults = [{ source: 'hitomi', galleryId: 'review-later', title: 'Review Later', tags: [], artists: ['Artist'] }];
    await checkWatchedSearches(log);
    setGalleriesReviewed([{ source: 'hitomi', galleryId: 'review-later' }], true);
    const second = addWatchedSearch('hitomi', 'artist:review-second');
    searchResults = [];
    await checkWatchedSearches(log);
    searchResults = [{ source: 'hitomi', galleryId: 'review-later', title: 'Review Later', tags: [], artists: ['Artist'] }];
    await checkWatchedSearches(log);
    assert.equal(listGalleryFeed({ searchId: second.id, view: 'inbox' }).total, 0);
    assert.ok(listGalleryFeed({ searchId: second.id, view: 'history' }).items[0].reviewedAt);
    removeWatchedSearch(first.id, first.revision);
    assert.ok(listGalleryFeed({ searchId: first.id, view: 'history' }).items[0].reviewedAt);
  });

  it('records failed attempts without replacing the last successful check and clears errors on recovery', async () => {
    const watch = addWatchedSearch('hitomi', 'artist:failure-status');
    searchResults = [];
    await checkWatchedSearches(log);
    const lastChecked = listWatchedSearches().find(item => item.id === watch.id)!.lastCheckedAt;
    const search = doujinProviders.hitomi.search;
    try {
      doujinProviders.hitomi.search = async () => { throw Error('Provider unavailable'); };
      const failed = await checkWatchedSearches(log);
      assert.ok(failed.failed > 0);
      const state = listWatchedSearches().find(item => item.id === watch.id)!;
      assert.equal(state.lastError, 'Provider unavailable');
      assert.ok(state.lastAttemptedAt);
      assert.equal(state.lastCheckedAt, lastChecked);
    } finally { doujinProviders.hitomi.search = search; }
    await checkWatchedSearches(log);
    assert.equal(listWatchedSearches().find(item => item.id === watch.id)!.lastError, null);
  });

  it('validates feed/review APIs and reports a check older than the last 100 unrelated jobs', async () => {
    const { api } = await import('../src/routes/api.js');
    for (const query of ['offset=-1', 'limit=101', 'source=unsupported', 'searchId=abc', 'view=all']) assert.equal((await api.request(`/watched-searches/feed?${query}`)).status, 400);
    const response = await api.request('/watched-searches/feed?view=history&searchId=90001&limit=12&offset=12');
    const feed = await response.json();
    assert.equal(response.status, 200);
    assert.equal(feed.total, 17);
    assert.equal(feed.items.length, 5);
    for (const body of [{ items: [], reviewed: true }, { items: [{ source: 'unsupported', galleryId: '1' }], reviewed: true }, { items: [{ source: 'hitomi', galleryId: '1' }], reviewed: 'true' }]) assert.equal((await api.request('/watched-searches/review', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).status, 400);
    const id = Number(getDb().insert(schema.jobs).values({ type: 'check-watched-searches', status: 'completed', payloadJson: '{}' }).run().lastInsertRowid);
    getDb().insert(schema.jobs).values(Array.from({ length: 101 }, () => ({ type: 'scan-new', status: 'completed', payloadJson: '{}' }))).run();
    assert.equal((await (await api.request('/watched-searches/check-status')).json()).id, id);
  });
});
