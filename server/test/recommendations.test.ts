import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { eq } from 'drizzle-orm';
import type { DoujinProvider, DoujinSearchOptions, DoujinSearchResult, DoujinSort, DoujinSource } from '../src/downloader/types.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'htosho-recommendations-'));
process.env.HTOSHO_DATA_DIR = dataDir;

// Dynamic imports are required here: the DB module snapshots HTOSHO_DATA_DIR at module load.
const { initDb, getDb, schema } = await import('../src/db/index.js');
const { doujinProviders } = await import('../src/downloader/providers.js');
const recs = await import('../src/services/recommendations.js');
const { DEFAULT_DOWNLOADER, setDownloaderSettings } = await import('../src/services/settings.js');

initDb();
const originals: Record<string, DoujinProvider> = { ...doujinProviders };
after(() => {
  for (const [id, provider] of Object.entries(originals)) {
    doujinProviders[id as DoujinSource] = provider;
  }
});

function localDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function stubProvider(source: DoujinSource, idsForQuery: (query: string) => string[]): DoujinProvider {
  return {
    id: source,
    name: source,
    color: '#000',
    async search(query: string, limit?: number): Promise<DoujinSearchResult[]> {
      const ids = idsForQuery(query).slice(0, limit ?? undefined);
      return ids.map((galleryId) => ({ source, galleryId, title: `${source} ${galleryId}`, tags: [], artists: [] }));
    },
  };
}

const slug = (q: string) => q.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
const keySet = (items: { source: string; galleryId: string }[]) => new Set(items.map((it) => `${it.source}:${it.galleryId}`));
const overlap = (a: Set<string>, b: Set<string>) => [...a].filter((k) => b.has(k)).length;

interface TestHistoryEntry { key: string; date: string; servedAt: string; item: unknown }

function historyRows(): TestHistoryEntry[] {
  return getDb().select().from(schema.recommendationHistory).all().map((row) => ({
    key: `${row.source}:${row.galleryId}`,
    date: row.servedDate,
    servedAt: row.servedAt,
    item: JSON.parse(row.itemJson),
  }));
}

function writeHistoryRows(history: TestHistoryEntry[]): void {
  getDb().delete(schema.recommendationHistory).run();
  for (const entry of history) {
    const separator = entry.key.indexOf(':');
    getDb().insert(schema.recommendationHistory).values({
      source: entry.key.slice(0, separator),
      galleryId: entry.key.slice(separator + 1),
      servedDate: entry.date,
      servedAt: entry.servedAt,
      itemJson: JSON.stringify(entry.item),
    }).run();
  }
}

// Taste profile: two artists + two tags across five "downloaded" galleries.
for (let i = 0; i < 3; i++) {
  recs.recordGalleryTags('hitomi', { source: 'hitomi', galleryId: `dl${i}`, title: `DL ${i}`, pages: [], artists: ['alpha', 'beta'], tags: ['vanilla', 'romance'] });
}
for (let i = 0; i < 2; i++) {
  recs.recordGalleryTags('nhentai', { source: 'nhentai', galleryId: `dl${i}`, title: `DL ${i}`, pages: [], artists: ['alpha'], tags: ['vanilla'] });
}

test('fresh picks do not repeat across refreshes and days while candidates remain', async () => {
  // Legacy per-day seen row from the pre-history format: must migrate into the rolling history.
  const today = localDate(new Date());
  getDb()
    .insert(schema.keyValueStore)
    .values({
      key: `recommendations-seen:${today}`,
      valueJson: JSON.stringify([
        { source: 'hitomi', galleryId: 'legacy-1', title: 'Legacy 1', tags: [], artists: [], reasons: [] },
        { source: 'nhentai', galleryId: 'legacy-2', title: 'Legacy 2', tags: [], artists: [], reasons: [] },
      ]),
    })
    .run();

  // Distinct galleries per query, so every refresh has a large fresh pool.
  const uniquePerQuery = (q: string) => Array.from({ length: 30 }, (_, i) => `${slug(q)}#${i}`);
  doujinProviders.hitomi = stubProvider('hitomi', uniquePerQuery);
  // The recommender must not touch nHentai — picks come from Hitomi only.
  let nhentaiSearches = 0;
  doujinProviders.nhentai = { ...originals.nhentai, search: async () => { nhentaiSearches++; return []; } };

  const set1 = await recs.getRecommendations();
  assert.equal(set1.items.length, 12);
  assert.ok(set1.items.some((it) => it.reasons.length > 0), 'no library picks in the set');

  const set2 = await recs.refreshRecommendations();
  assert.equal(set2.items.length, 12);
  assert.equal(overlap(keySet(set2.items), keySet(set1.items)), 0, 'same-day refresh re-served picks');

  // The legacy seen row was migrated into the rolling history and deleted.
  const rows = getDb().select().from(schema.keyValueStore).all();
  assert.ok(!rows.some((r) => r.key.startsWith('recommendations-seen:')), 'legacy seen row survived');
  const history = historyRows();
  assert.ok(history.some((h) => h.key === 'hitomi:legacy-1'), 'legacy pick missing from history');
  assert.ok(history.some((h) => h.key === 'nhentai:legacy-2'), 'legacy pick missing from history');

  // Simulate the next day: history entries dated yesterday must still be
  // excluded — that exclusion is what stops day-over-day repeats.
  const yesterday = localDate(new Date(Date.now() - 86_400_000));
  writeHistoryRows(history.map((h) => ({ ...h, date: yesterday })));
  const set3 = await recs.refreshRecommendations();
  assert.equal(set3.items.length, 12);
  assert.equal(
    overlap(keySet(set3.items), keySet([...set1.items, ...set2.items])),
    0,
    'next-day generation re-served previously-shown picks',
  );
  assert.equal(nhentaiSearches, 0, 'recommender queried nHentai');
});

test('manual refresh during an in-flight generation re-rolls instead of joining it', async () => {
  // The previous test leaves today's cached set behind; clear it so the first
  // getRecommendations() below actually starts a (gated) generation.
  const today = localDate(new Date());
  getDb().delete(schema.keyValueStore).where(eq(schema.keyValueStore.key, `recommendations-v2:${today}`)).run();

  let releaseGate: (() => void) | null = null;
  const gate = new Promise<void>((r) => { releaseGate = r; });
  let searchCalls = 0;
  const gatedProvider = (source: DoujinSource): DoujinProvider => ({
    id: source,
    name: source,
    color: '#000',
    async search(query: string, limit?: number): Promise<DoujinSearchResult[]> {
      searchCalls++;
      await gate;
      const ids = Array.from({ length: 30 }, (_, i) => `${slug(query)}#${i}`);
      return ids.slice(0, limit ?? undefined).map((galleryId) => ({ source, galleryId, title: `${source} ${galleryId}`, tags: [], artists: [] }));
    },
  });
  doujinProviders.hitomi = gatedProvider('hitomi');

  const first = recs.getRecommendations(); // starts the day's generation, stuck on the gate
  const second = recs.refreshRecommendations(); // must wait for it, then run its own roll
  releaseGate!();
  const [set1, set2] = await Promise.all([first, second]);
  assert.equal(set1.items.length, 12);
  assert.equal(set2.items.length, 12);
  assert.equal(overlap(keySet(set1.items), keySet(set2.items)), 0, 'second roll re-served picks from the first');
});

test('empty daily generation is persisted and changes only on a manual refresh', async () => {
  // Fresh boundary: no history to recycle into the (would-be) set.
  getDb().delete(schema.recommendationHistory).run();
  const today = localDate(new Date());
  getDb().delete(schema.keyValueStore).where(eq(schema.keyValueStore.key, `recommendations-v2:${today}`)).run();

  let searchCalls = 0;
  const emptyProvider = (source: DoujinSource): DoujinProvider => ({
    id: source,
    name: source,
    color: '#000',
    async search(): Promise<DoujinSearchResult[]> {
      searchCalls++;
      return [];
    },
  });
  doujinProviders.hitomi = emptyProvider('hitomi');

  const set1 = await recs.getRecommendations();
  assert.equal(set1.items.length, 0);
  assert.ok(getDb().select().from(schema.keyValueStore).all().some((r) => r.key === `recommendations-v2:${today}`), 'empty daily set must persist');

  // While the sources stay down, subsequent reads must not re-run the pipeline.
  const callsAfterFirst = searchCalls;
  const set2 = await recs.getRecommendations();
  assert.equal(set2.items.length, 0);
  assert.equal(set2.generatedAt, set1.generatedAt);
  assert.equal(searchCalls, callsAfterFirst, 'an empty set must not regenerate on another app opening');

  // A manual refresh explicitly re-rolls, even after an empty first pass.
  const set3 = await recs.refreshRecommendations();
  assert.equal(set3.items.length, 0);
  assert.ok(searchCalls > callsAfterFirst, 'manual refresh did not regenerate the empty set');
});

test('same-day exhaustion reuses least-recent picks to keep twelve visible', async () => {
  getDb().delete(schema.recommendationHistory).run();

  // Twenty-four galleries shared by every query — two fresh sets, then the
  // least-recent first set must be reused to preserve the twelve-card contract.
  const shared = () => Array.from({ length: 24 }, (_, i) => String(i));
  doujinProviders.hitomi = stubProvider('hitomi', shared);
  const set1 = await recs.refreshRecommendations();
  assert.equal(set1.items.length, 12);
  const set2 = await recs.refreshRecommendations();
  assert.equal(set2.items.length, 12);
  assert.equal(overlap(keySet(set2.items), keySet(set1.items)), 0, 'second refresh re-served picks while fresh candidates remained');

  const set3 = await recs.refreshRecommendations();
  assert.equal(set3.items.length, 12);
  assert.equal(set3.repeatedCount, 12);
  assert.equal(set3.degradedReason, 'same-day-pool-exhausted');
  assert.deepEqual(keySet(set3.items), keySet(set1.items));
});

test('exhausted pool recycles previously-served picks from earlier days, never today\'s', async () => {
  getDb().delete(schema.recommendationHistory).run();

  const shared = () => Array.from({ length: 24 }, (_, i) => String(i));
  doujinProviders.hitomi = stubProvider('hitomi', shared);
  const set1 = await recs.refreshRecommendations();
  const set2 = await recs.refreshRecommendations();
  assert.equal(set1.items.length, 12);
  assert.equal(set2.items.length, 12);
  assert.equal(overlap(keySet(set2.items), keySet(set1.items)), 0, 'second refresh re-served picks while fresh candidates remained');

  // Yesterday's picks sit at the front of the history (oldest first).
  const yesterday = localDate(new Date(Date.now() - 86_400_000));
  const older = Array.from({ length: 12 }, (_, i) => ({
    key: `hitomi:old-${i}`,
    date: yesterday,
    servedAt: `${yesterday}T00:00:${String(i).padStart(2, '0')}.000Z`,
    item: { source: 'hitomi', galleryId: `old-${i}`, title: `Old ${i}`, tags: [], artists: [], reasons: [] as string[] },
  }));
  writeHistoryRows([...older, ...historyRows()]);

  // Fresh pool exhausted → tops up from the least-recent entries, yesterday's.
  const set3 = await recs.refreshRecommendations();
  assert.equal(set3.items.length, 12);
  const servedToday = keySet([...set1.items, ...set2.items]);
  for (const it of set3.items) {
    const k = `${it.source}:${it.galleryId}`;
    assert.ok(!servedToday.has(k), `same-day re-serve: ${k}`);
    assert.ok(k.startsWith('hitomi:old-'), `expected a recycled older pick, got ${k}`);
  }
  assert.equal(set3.repeatedCount, 12);

  // Re-serving a recycled pick refreshes its exclusion window.

  const today = localDate(new Date());
  assert.ok(historyRows().every((h) => h.date === today), 'history kept stale serve dates after recycling');
});
test('dismissal promotes a replacement without changing ownership and supports undo', async () => {
  getDb().delete(schema.recommendationHistory).run();
  let searchCalls = 0;
  const available = () => {
    searchCalls += 1;
    return Array.from({ length: 48 }, (_, i) => `replacement-${i}`);
  };
  doujinProviders.hitomi = stubProvider('hitomi', available);

  const initial = await recs.refreshRecommendations();
  assert.equal(initial.items.length, 12);
  const callsAfterGeneration = searchCalls;
  const owned = initial.items[0];
  const replacement = await recs.dismissAndReplace(owned.source, owned.galleryId);

  assert.equal(searchCalls, callsAfterGeneration, 'marking owned performed remote searches');
  assert.equal(replacement.items.length, 12);
  assert.ok(!keySet(replacement.items).has(`${owned.source}:${owned.galleryId}`));
  assert.ok(replacement.dismissedKeys.includes(`${owned.source}:${owned.galleryId}`));
  assert.ok(!replacement.ownedKeys.includes(`${owned.source}:${owned.galleryId}`));
  const restored = await recs.undoDismiss(owned.source, owned.galleryId);
  assert.ok(keySet(restored.items).has(`${owned.source}:${owned.galleryId}`));
  assert.ok(!restored.dismissedKeys.includes(`${owned.source}:${owned.galleryId}`));
});

test('repeated refreshes rotate through a static ranking via seeded skips', async () => {
  getDb().delete(schema.recommendationHistory).run();

  // One long static ranking shared by every query (like Hitomi's popularity
  // sort for a narrow niche), honoring the skip option like the real provider.
  const RANK = Array.from({ length: 90 }, (_, i) => `shared-${i}`);
  doujinProviders.hitomi = {
    id: 'hitomi',
    name: 'hitomi',
    color: '#000',
    async search(query: string, limit?: number, _sort?: DoujinSort, opts?: DoujinSearchOptions): Promise<DoujinSearchResult[]> {
      const start = Math.min(opts?.skip ?? 0, RANK.length);
      return RANK.slice(start, start + (limit ?? 24)).map((galleryId) => ({ source: 'hitomi', galleryId, title: galleryId, tags: [], artists: [] }));
    },
  };

  const union = new Set<string>();
  for (let i = 0; i < 6; i++) {
    const set = await recs.refreshRecommendations();
    for (const it of set.items) union.add(`${it.source}:${it.galleryId}`);
  }
  // Without window rotation every roll would draw the identical top slice and
  // the union over six refreshes would be exactly 12.
  assert.ok(union.size > 12, `rotation not observed: ${union.size} distinct picks over 6 refreshes`);
});

test('backfills missing metadata after the first ten rows and includes nHentai downloads', async () => {
  getDb().delete(schema.recommendationHistory).run();
  getDb().delete(schema.downloadQueue).run();
  for (let i = 0; i < 11; i++) {
    recs.recordGalleryTags('hitomi', { source: 'hitomi', galleryId: `existing-${i}`, title: `Existing ${i}`, pages: [], artists: [], tags: ['existing'] });
  }
  getDb().insert(schema.downloadQueue).values({ source: 'nhentai', galleryId: 'legacy-nh', title: 'Legacy', status: 'completed' }).run();
  let hydrated = false;
  doujinProviders.nhentai = {
    ...originals.nhentai,
    async getGallery() {
      hydrated = true;
      return { source: 'nhentai', galleryId: 'legacy-nh', title: 'Legacy', pages: ['page'], artists: ['legacy artist'], tags: ['legacy tag'] };
    },
  };
  doujinProviders.hitomi = stubProvider('hitomi', () => []);

  await recs.refreshRecommendations();
  assert.equal(hydrated, true);
  assert.ok(getDb().select().from(schema.galleryTags).all().some((row) => row.source === 'nhentai' && row.galleryId === 'legacy-nh'));
});

test('profile mutation during generation cannot commit the stale set', async () => {
  getDb().delete(schema.recommendationHistory).run();
  const today = localDate(new Date());
  getDb().delete(schema.keyValueStore).where(eq(schema.keyValueStore.key, `recommendations-v2:${today}`)).run();
  let release: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let gated = true;
  doujinProviders.hitomi = {
    ...stubProvider('hitomi', (query) => Array.from({ length: 30 }, (_, i) => `${slug(query)}-${i}`)),
    async search(query: string, limit?: number): Promise<DoujinSearchResult[]> {
      if (gated) {
        gated = false;
        await gate;
      }
      return Array.from({ length: limit ?? 12 }, (_, i) => ({ source: 'hitomi', galleryId: `${slug(query)}-${i}-${gated}`, title: query, tags: [], artists: [] }));
    },
  };

  const pending = recs.refreshRecommendations();
  recs.setExcludedLibraries([99]);
  release!();
  const set = await pending;
  const cached = getDb().select().from(schema.keyValueStore).where(eq(schema.keyValueStore.key, `recommendations-v2:${today}`)).get();
  assert.ok(cached);
  assert.deepEqual(JSON.parse(cached.valueJson).items, set.items);
});

test('reports popular mode when profile searches produce no personalized picks', async () => {
  getDb().delete(schema.recommendationHistory).run();
  doujinProviders.hitomi = stubProvider('hitomi', (query) => query === 'doujinshi' ? Array.from({ length: 12 }, (_, i) => `popular-${i}`) : []);
  const set = await recs.refreshRecommendations();
  assert.equal(set.mode, 'popular');
  assert.ok(set.items.every((item) => item.reasons.length === 0));
});

test('diversity caps apply to every matched artist and language stays a soft preference', async () => {
  getDb().delete(schema.recommendationHistory).run();
  const queries: string[] = [];
  doujinProviders.hitomi = {
    ...stubProvider('hitomi', () => []),
    async search(query: string, limit?: number): Promise<DoujinSearchResult[]> {
      queries.push(query);
      return Array.from({ length: limit ?? 12 }, (_, i) => ({ source: 'hitomi', galleryId: `${slug(query)}-${i}`, title: query, language: i % 2 ? 'english' : 'japanese', tags: ['vanilla'], artists: ['alpha'] }));
    },
  };
  const set = await recs.refreshRecommendations();
  assert.ok(queries.every((query) => !query.includes('language:')), 'language preference was used as a hard query filter');
  assert.ok(set.items.filter((item) => item.reasons.includes('artist alpha')).length <= 1, 'artist diversity cap was bypassed');
});
test('completed downloads preserve remaining picks and their order until an explicit refresh', async () => {
  const today = localDate(new Date());
  let searches = 0;
  doujinProviders.hitomi = {
    ...stubProvider('hitomi', () => []),
    async search(query: string, limit?: number) {
      searches++;
      return Array.from({ length: limit ?? 30 }, (_, i) => ({ source: 'hitomi' as const, galleryId: `stable-${slug(query)}-${i}`, title: `Stable ${query} ${i}`, tags: [], artists: [] }));
    },
  };
  const initial = await recs.refreshRecommendations();
  assert.equal(initial.items.length, 12);
  const cacheBefore = getDb().select().from(schema.keyValueStore).where(eq(schema.keyValueStore.key, `recommendations-v2:${today}`)).get()!.valueJson;
  const callsBefore = searches;
  const complete = (item: typeof initial.items[number]) => recs.recordGalleryTags(item.source, { ...item, pages: [], artists: ['new artist'], tags: ['new tag'] });
  complete(initial.items[3]);
  complete(initial.items[8]);
  const expected = initial.items.filter((_, i) => i !== 3 && i !== 8);
  const remaining = await recs.getRecommendations();
  assert.deepEqual(remaining.items, expected, 'download reshuffled or replaced remaining picks');
  assert.equal(remaining.generatedAt, initial.generatedAt);
  assert.ok(remaining.ownedKeys.includes(`hitomi:${initial.items[3].galleryId}`));
  assert.deepEqual((await recs.getRecommendations()).items, expected, 'reopening the tab changed remaining picks');
  assert.equal(searches, callsBefore, 'completed download triggered a new recommendation search');
  assert.equal(getDb().select().from(schema.keyValueStore).where(eq(schema.keyValueStore.key, `recommendations-v2:${today}`)).get()!.valueJson, cacheBefore);

  // Even when every pick has been downloaded, only Refresh should roll a new set.
  expected.forEach(complete);
  assert.deepEqual((await recs.getRecommendations()).items, []);
  assert.equal(searches, callsBefore);
  const refreshed = await recs.refreshRecommendations();
  assert.ok(refreshed.items.length > 0);
  assert.equal(overlap(keySet(initial.items), keySet(refreshed.items)), 0);
  assert.ok(refreshed.profile.artists.includes('new artist'), 'refresh did not learn from completed downloads');
});

test('malformed cached recommendation payloads are regenerated', async () => {
  getDb().delete(schema.recommendationHistory).run();
  const today = localDate(new Date());
  getDb().insert(schema.keyValueStore).values({ key: `recommendations-v2:${today}`, valueJson: JSON.stringify({ date: today, generatedAt: 'bad', mode: 'library', profile: { artists: [], tags: [], series: [], language: null }, items: [{ source: 'hitomi' }] }) }).onConflictDoUpdate({ target: schema.keyValueStore.key, set: { valueJson: JSON.stringify({ items: [{ source: 'hitomi' }] }) } }).run();
  doujinProviders.hitomi = stubProvider('hitomi', (query) => query === 'doujinshi' ? ['regenerated'] : []);
  const set = await recs.getRecommendations();
  assert.ok(set.items.some((item) => item.galleryId === 'regenerated'));
});

test('current bans exclude cached and recycled recommendation cards', async () => {
  getDb().delete(schema.recommendationHistory).run();
  const today = localDate(new Date());
  const item = { source: 'hitomi', galleryId: 'banned-history', title: 'Blocked gallery', tags: ['blocked'], artists: [], reasons: [] };
  writeHistoryRows([{ key: 'hitomi:banned-history', date: today, servedAt: new Date().toISOString(), item }]);
  setDownloaderSettings({ ...DEFAULT_DOWNLOADER, hitomiBannedTags: ['blocked'] });
  doujinProviders.hitomi = stubProvider('hitomi', () => []);
  try {
    const set = await recs.refreshRecommendations();
    assert.equal(set.items.some((pick) => pick.galleryId === 'banned-history'), false);
    assert.equal((await recs.getRecommendations()).items.some((pick) => pick.galleryId === 'banned-history'), false);
  } finally {
    setDownloaderSettings(DEFAULT_DOWNLOADER);
  }
});

test('download ownership survives queue clearing and warm refresh needs no new search', async () => {
  getDb().delete(schema.recommendationHistory).run();
  recs.recordGalleryTags('hitomi', { source: 'hitomi', galleryId: 'durable-owned', title: 'Owned', tags: [], artists: [], pages: [] });
  getDb().delete(schema.downloadQueue).run();
  let searches = 0;
  doujinProviders.hitomi = {
    ...stubProvider('hitomi', () => []),
    async search(query, limit) {
      searches += 1;
      return ['durable-owned', ...Array.from({ length: 100 }, (_, i) => `${slug(query)}-warm-${i}`)].slice(0, limit ?? 24).map((galleryId) => ({ source: 'hitomi', galleryId, title: galleryId, tags: [], artists: [] }));
    },
  };
  const first = await recs.refreshRecommendations();
  const calls = searches;
  const second = await recs.refreshRecommendations();
  assert.equal(first.items.some((item) => item.galleryId === 'durable-owned'), false);
  assert.equal(second.items.some((item) => item.galleryId === 'durable-owned'), false);
  assert.ok(second.ownedKeys.includes('hitomi:durable-owned'));
  assert.equal(searches, calls);
  assert.equal(overlap(keySet(first.items), keySet(second.items)), 0);
});

test('artist-constrained warm pools fetch fresh candidates before reusing history', async () => {
  getDb().delete(schema.recommendationHistory).run();
  let searches = 0;
  let diverse = false;
  const fetchedKeys = new Set<string>();
  doujinProviders.hitomi = {
    ...stubProvider('hitomi', () => []),
    async search(query, limit = 24) {
      searches += 1;
      return Array.from({ length: limit }, (_, i) => {
        const galleryId = `${diverse ? 'diverse' : 'constrained'}-${slug(query)}-${i}`;
        fetchedKeys.add(galleryId);
        return { source: 'hitomi' as const, galleryId, title: galleryId, tags: [], artists: diverse ? [galleryId] : ['shared artist'] };
      });
    },
  };

  const first = await recs.refreshRecommendations();
  assert.equal(first.items.length, 1);
  assert.ok(fetchedKeys.size > 24, 'scenario must have enough raw galleries to appear full');
  const calls = searches;
  diverse = true;
  const second = await recs.refreshRecommendations();
  assert.ok(searches > calls, 'artist-constrained pool prevented replenishment');
  assert.ok(searches - calls <= 10, 'replenishment exceeded one batch of searches');
  assert.equal(second.items.length, 12);
  assert.equal(second.repeatedCount, 0);
  assert.equal(overlap(keySet(first.items), keySet(second.items)), 0);
  assert.equal(new Set(second.items.flatMap((item) => item.artists)).size, 12);
});

test('provider exclusions do not let an ineligible warm pool prevent replenishment', async () => {
  getDb().delete(schema.recommendationHistory).run();
  setDownloaderSettings({ ...DEFAULT_DOWNLOADER, hitomiBannedTags: ['blocked'] });
  let searches = 0;
  let excludeOld = false;
  doujinProviders.hitomi = {
    ...stubProvider('hitomi', () => []),
    async search(query, limit = 24) {
      searches += 1;
      return Array.from({ length: limit }, (_, i) => {
        const galleryId = `${excludeOld ? 'eligible-new' : 'eligible-old'}-${slug(query)}-${i}`;
        return { source: 'hitomi' as const, galleryId, title: galleryId, tags: [], artists: [] };
      });
    },
    async filterRecommendations(items) {
      return excludeOld ? items.filter((item) => item.galleryId.startsWith('eligible-new')) : items;
    },
  };
  try {
    const first = await recs.refreshRecommendations();
    assert.equal(first.items.length, 12);
    const calls = searches;
    excludeOld = true;
    const second = await recs.refreshRecommendations();
    assert.ok(searches > calls, 'ineligible pool prevented replenishment');
    assert.equal(second.items.length, 12);
    assert.ok(second.items.every((item) => item.galleryId.startsWith('eligible-new')));
    assert.equal(second.repeatedCount, 0);
  } finally {
    setDownloaderSettings(DEFAULT_DOWNLOADER);
  }
});

test('popular reserves exclude visible cards and replace all twelve dismissals without searches', async () => {
  getDb().delete(schema.recommendationHistory).run();
  let searches = 0;
  const ids = Array.from({ length: 24 }, (_, i) => `popular-reserve-${i}`);
  doujinProviders.hitomi = stubProvider('hitomi', (query) => {
    searches += 1;
    return query === 'doujinshi' ? ids : [];
  });

  const initial = await recs.refreshRecommendations();
  assert.equal(initial.mode, 'popular');
  assert.equal(initial.items.length, 12);
  const today = localDate(new Date());
  const row = getDb().select().from(schema.keyValueStore).where(eq(schema.keyValueStore.key, `recommendations-v2:${today}`)).get();
  assert.ok(row);
  const cached = JSON.parse(row.valueJson) as { reserve: DoujinSearchResult[] };
  assert.equal(cached.reserve.length, 12);
  assert.equal(overlap(keySet(initial.items), keySet(cached.reserve)), 0);

  const calls = searches;
  let current = initial;
  for (const item of initial.items) {
    current = await recs.dismissAndReplace(item.source, item.galleryId);
    assert.equal(current.items.length, 12, 'dismissal ran out of usable reserves');
    assert.equal(searches, calls, 'dismissal performed remote searches');
    assert.ok(!keySet(current.items).has(`${item.source}:${item.galleryId}`));
  }
  assert.deepEqual(keySet(current.items), keySet(cached.reserve));
});

test('metadata and recommendation preference changes preserve the daily set until explicit refresh', async () => {
  let calls = 0;
  const provider = stubProvider('hitomi', () => Array.from({ length: 100 }, (_, index) => `stable-day-${index}`));
  doujinProviders.hitomi = { ...provider, async search(...args) { calls++; return provider.search(...args); } };
  const first = await recs.refreshRecommendations();
  const before = calls;
  const today = localDate(new Date());
  const cacheBefore = getDb().select().from(schema.keyValueStore).where(eq(schema.keyValueStore.key, `recommendations-v2:${today}`)).get()!.valueJson;
  const { invalidateRecommendationSeries } = await import('../src/services/recommendationSignals.js');
  invalidateRecommendationSeries(42);
  setDownloaderSettings(DEFAULT_DOWNLOADER);
  recs.setExcludedLibraries([7]);
  const second = await recs.getRecommendations();
  assert.deepEqual(second.items, first.items);
  assert.equal(second.generatedAt, first.generatedAt);
  assert.equal(calls, before, 'changing inputs must not run provider searches');
  assert.equal(getDb().select().from(schema.keyValueStore).where(eq(schema.keyValueStore.key, `recommendations-v2:${today}`)).get()!.valueJson, cacheBefore);
  recs.setExcludedLibraries([]);
  await recs.refreshRecommendations();
  assert.ok(calls > before, 'explicit refresh uses updated inputs');
});

test('the next day generates new recommendations only when the app requests them again', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2030-01-10T12:00:00Z') });
  let calls = 0;
  doujinProviders.hitomi = {
    ...stubProvider('hitomi', () => []),
    async search(query, limit) {
      calls++;
      return Array.from({ length: limit ?? 30 }, (_, index) => ({ source: 'hitomi' as const, galleryId: `${localDate(new Date())}-${slug(query)}-${index}`, title: `Daily ${index}`, artists: [], tags: [] }));
    },
  };
  const first = await recs.getRecommendations();
  const before = calls;
  assert.equal(first.date, '2030-01-10');
  assert.deepEqual((await recs.getRecommendations()).items, first.items);
  assert.equal(calls, before);
  t.mock.timers.tick(86_400_000);
  assert.equal(calls, before, 'midnight must not start automatic generation');
  const edited = await recs.dismissAndReplace('hitomi', first.items[0].galleryId);
  assert.equal(edited.date, first.date, 'feedback after midnight should edit the displayed day');
  assert.equal(calls, before, 'dismissing a card after midnight must not generate a new daily set');
  const next = await recs.getRecommendations();
  assert.equal(next.date, '2030-01-11');
  assert.ok(calls > before);
  assert.equal(overlap(keySet(first.items), keySet(next.items)), 0);
});
