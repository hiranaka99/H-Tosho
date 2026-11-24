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
const { buildProfile } = await import('../src/services/recommendationProfile.js');
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
  assert.ok(buildProfile([]).terms.some(term => term.kind === 'artist' && term.name === 'new artist' && term.weight >= 12), 'completed downloads did not update the taste inputs');
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

test('background preloading persists picks at startup and each local day without app requests', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: new Date(2030, 0, 10, 23, 59, 30) });
  let calls = 0;
  doujinProviders.hitomi = {
    ...stubProvider('hitomi', () => []),
    async search(query, limit) {
      calls++;
      return Array.from({ length: limit ?? 30 }, (_, index) => ({ source: 'hitomi' as const, galleryId: `${localDate(new Date())}-${slug(query)}-${index}`, title: `Daily ${index}`, artists: [], tags: [] }));
    },
  };
  const tick = () => new Promise<void>(resolve => setImmediate(resolve));
  const cached = (date: string) => getDb().select().from(schema.keyValueStore).where(eq(schema.keyValueStore.key, `recommendations-v2:${date}`)).get();
  const stop = recs.startRecommendationPreloading();
  t.after(stop);
  await tick();
  assert.ok(cached('2030-01-10'), 'startup must persist picks before any app request');
  assert.ok(calls > 0);
  const before = calls;
  const first = await recs.getRecommendations();
  assert.equal(first.date, '2030-01-10');
  assert.equal(calls, before);

  t.mock.timers.tick(30_000);
  const edited = await recs.dismissAndReplace('hitomi', first.items[0].galleryId);
  assert.equal(edited.date, first.date, 'feedback after midnight should edit the displayed day');
  assert.equal(calls, before, 'dismissing a card after midnight must not generate a new daily set');

  t.mock.timers.tick(30_000);
  await tick();
  assert.ok(cached('2030-01-11'), 'daily picks must be ready without an app request');
  const afterPreload = calls;
  const next = await recs.getRecommendations();
  assert.equal(next.date, '2030-01-11');
  assert.notEqual(next.generatedAt, first.generatedAt);
  assert.equal(calls, afterPreload, 'opening the app must reuse preloaded picks');
  assert.equal(overlap(keySet(first.items), keySet(next.items)), 0);

  // Restarts and periodic checks must reuse today's persisted selection.
  stop();
  const stopRestarted = recs.startRecommendationPreloading();
  t.after(stopRestarted);
  await tick();
  t.mock.timers.tick(60_000);
  await tick();
  assert.equal(calls, afterPreload, 'same-day startup and timer checks must not re-roll');
  assert.deepEqual((await recs.getRecommendations()).items, next.items);

  stopRestarted();
  t.mock.timers.tick(86_400_000);
  await tick();
  assert.equal(calls, afterPreload, 'shutdown must stop background preloading');
  assert.equal(cached('2030-01-12'), undefined);
  const stopCatchUp = recs.startRecommendationPreloading();
  t.after(stopCatchUp);
  await tick();
  assert.ok(cached('2030-01-12'), 'startup after downtime must prepare the current day');
});

test('slow background preloading shares generation with app requests and skips overlapping ticks', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: new Date(2030, 0, 15, 12) });
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let calls = 0;
  doujinProviders.hitomi = {
    ...stubProvider('hitomi', () => []),
    async search(query, limit = 30) {
      calls++;
      entered.resolve();
      await release.promise;
      return Array.from({ length: limit }, (_, index) => ({ source: 'hitomi' as const, galleryId: `preload-${slug(query)}-${index}`, title: `Preloaded ${index}`, artists: [], tags: [] }));
    },
  };
  const stop = recs.startRecommendationPreloading();
  t.after(stop);
  try {
    await entered.promise;
    const before = calls;
    t.mock.timers.tick(180_000);
    const request = recs.getRecommendations();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(calls, before, 'timer ticks and app requests must not start another generation');
    release.resolve();
    const result = await request;
    assert.equal(result.items.length, 12);
    const afterPreload = calls;
    assert.deepEqual((await recs.getRecommendations()).items, result.items);
    assert.equal(calls, afterPreload);
  } finally { release.resolve(); }
});

test('background preloading retries a failed attempt on the next tick', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: new Date(2030, 0, 20, 12) });
  const db = getDb();
  const select = db.select;
  let fail = true;
  const selectMock = t.mock.method(db, 'select', function (...args: Parameters<typeof select>) {
    if (fail) { fail = false; throw new Error('Temporary database failure'); }
    return select.apply(db, args);
  });
  const warning = t.mock.method(console, 'warn', () => {});
  let calls = 0;
  const provider = stubProvider('hitomi', query => Array.from({ length: 30 }, (_, index) => `retry-${slug(query)}-${index}`));
  doujinProviders.hitomi = { ...provider, async search(...args) { calls++; return provider.search(...args); } };
  const stop = recs.startRecommendationPreloading();
  t.after(stop);
  const tick = () => new Promise<void>(resolve => setImmediate(resolve));
  await tick();
  selectMock.mock.restore();
  assert.equal(calls, 0);
  assert.equal(warning.mock.callCount(), 1);
  t.mock.timers.tick(60_000);
  await tick();
  assert.ok(calls > 0);
  assert.ok(db.select().from(schema.keyValueStore).where(eq(schema.keyValueStore.key, 'recommendations-v2:2030-01-20')).get());
  const afterPreload = calls;
  await recs.getRecommendations();
  assert.equal(calls, afterPreload);
});


test('concurrent dismissals preserve both replacements when provider eligibility is delayed', async () => {
  const { getDownloaderSettings } = await import('../src/services/settings.js');
  const previousSettings = getDownloaderSettings();
  let serial = 0;
  doujinProviders.hitomi = {
    ...stubProvider('hitomi', () => []),
    async search(_query, limit = 30) {
      return Array.from({ length: limit }, () => ({ source: 'hitomi' as const, galleryId: `concurrent-${++serial}`, title: `Concurrent ${serial}`, tags: [], artists: [] }));
    },
  };
  setDownloaderSettings({ ...previousSettings, hitomiBannedTags: [] });
  const initial = await recs.refreshRecommendations();
  assert.equal(initial.items.length, 12);
  const [first, second] = initial.items;
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let checks = 0;
  doujinProviders.hitomi.filterRecommendations = async items => {
    if (++checks === 1) { entered.resolve(); await release.promise; }
    return items;
  };
  try {
    setDownloaderSettings({ ...previousSettings, hitomiBannedTags: ['blocked'] });
    const a = recs.dismissAndReplace(first.source, first.galleryId);
    await entered.promise;
    const b = recs.dismissAndReplace(second.source, second.galleryId);
    await Promise.resolve();
    assert.equal(checks, 1, 'a second displayed mutation crossed the in-flight commit');
    release.resolve();
    await Promise.all([a, b]);
    const result = await recs.getRecommendations();
    assert.equal(result.items.length, 12);
    assert.ok(!result.items.some(item => item.galleryId === first.galleryId || item.galleryId === second.galleryId));
    const cached = getDb().select().from(schema.keyValueStore).where(eq(schema.keyValueStore.key, `recommendations-v2:${result.date}`)).get()!;
    assert.deepEqual(JSON.parse(cached.valueJson).items, result.items);
  } finally {
    release.resolve();
    setDownloaderSettings(previousSettings);
  }
});

test('background preloading warms every daily cover once and retries only failed sets', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: new Date(2030, 1, 3, 9) });
  t.mock.method(console, 'warn', () => {});
  doujinProviders.hitomi = {
    ...stubProvider('hitomi', () => []),
    async search(query, limit = 30) {
      return Array.from({ length: limit }, (_, index) => ({ source: 'hitomi' as const, galleryId: `cover-${localDate(new Date())}-${slug(query)}-${index}`, title: `Cover ${index}`, artists: [], tags: [], coverUrl: `https://a2.gold-usergeneratedcontent.net/${localDate(new Date())}-${slug(query)}-${index}.avif` }));
    },
  };
  const batches: string[][] = [];
  let failNext = true;
  const stop = recs.startRecommendationPreloading(async (urls) => {
    batches.push(urls);
    const failed = failNext ? 1 : 0;
    failNext = false;
    return { loaded: urls.length - failed, failed };
  });
  t.after(stop);
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise<void>(resolve => setImmediate(resolve)); };
  await settle();
  const today = await recs.getRecommendations();
  assert.equal(batches.length, 1, 'startup must warm covers right after the daily set is ready');
  for (const item of today.items) assert.ok(batches[0].includes(item.coverUrl!), `cover for ${item.galleryId} was not warmed`);

  t.mock.timers.tick(60_000);
  await settle();
  assert.equal(batches.length, 2, 'a partially failed warm must retry on the next tick');
  t.mock.timers.tick(60_000);
  await settle();
  assert.equal(batches.length, 2, 'a fully warmed set must not be fetched again');

  t.mock.timers.tick(86_400_000);
  await settle();
  assert.equal(batches.length, 3, 'the next day must warm its own covers');
  assert.equal(overlap(new Set(batches[2]), new Set(batches[0])), 0);
});

test('parodies, co-occurring tag pairs, watched searches, Kavita engagement, and namespace resolution shape queries', async () => {
  const db = getDb();
  db.delete(schema.recommendationHistory).run();
  db.delete(schema.galleryTags).run();
  db.delete(schema.watchedSearches).run();
  db.delete(schema.dismissedGalleries).run();

  for (let i = 0; i < 4; i++) {
    recs.recordGalleryTags('hitomi', {
      source: 'hitomi',
      galleryId: `parody-dl-${i}`,
      title: `[Circle] Original Work ${i}`,
      pages: [],
      artists: ['fav artist'],
      tags: ['sole female', 'mosaic censorship', 'elf', 'stockings'],
      tagNamespaces: ['female', undefined, 'female', 'female'],
      parodies: ['blue archive'],
      language: 'japanese',
    });
  }
  // Active watched search adds taste signal.
  db.insert(schema.watchedSearches).values({ source: 'hitomi', query: 'artist:watched_author female:glasses' }).run();

  const kavitaProfile = buildProfile([
    { name: '[Artist] Single Title', tags: ['Action', 'glasses'], genres: ['Action'], artists: ['Penciller A'], hasUserRated: true, userRating: 5, pages: 30, pagesRead: 30 },
    { name: 'Clean Franchise', tags: ['low rated tag'], genres: [], artists: ['Low Artist'], hasUserRated: true, userRating: 1, pages: 30, pagesRead: 5 },
    // Linked to already-counted download — should not double-count base weight.
    { name: 'Linked Copy', tags: ['elf'], genres: [], artists: ['fav artist'], webLinks: 'https://hitomi.la/galleries/parody-dl-0.html', pages: 30, pagesRead: 30 },
  ]);
  assert.ok(!kavitaProfile.terms.some(t => t.kind === 'tag' && t.name.toLowerCase() === 'action'), 'generic Kavita genre should be filtered');
  assert.ok(!kavitaProfile.terms.some(t => t.kind === 'series' && t.name === '[Artist] Single Title'), 'bracketed doujin title must not become a series query');
  assert.ok(kavitaProfile.terms.some(t => t.kind === 'series' && t.name === 'blue archive' && t.nsBySource.hitomi === 'series'));
  assert.ok(kavitaProfile.terms.some(t => t.kind === 'artist' && t.name === 'watched author'));
  assert.ok(kavitaProfile.terms.some(t => t.kind === 'artist' && t.name === 'Penciller A'));
  const highWeight = kavitaProfile.terms.find(t => t.kind === 'artist' && t.name === 'Penciller A')!.weight;
  const lowWeight = kavitaProfile.terms.find(t => t.kind === 'artist' && t.name === 'Low Artist')!.weight;
  assert.ok(highWeight > lowWeight * 3, '5-star Kavita series should strongly outweigh 1-star series');
  assert.ok(kavitaProfile.tagPairs.some(p => [p.a.name, p.b.name].sort().join('+') === 'elf+stockings'), 'distinctive co-occurring pair should be extracted');

  const queries: { query: string; opts?: DoujinSearchOptions }[] = [];
  doujinProviders.hitomi = {
    ...stubProvider('hitomi', () => []),
    async resolveTagInfo(name: string) {
      if (name.toLowerCase() === 'glasses') return { name: 'glasses', ns: 'female', count: 15000 };
      return null;
    },
    async search(query, limit = 12, _sort, opts) {
      queries.push({ query, opts });
      return Array.from({ length: limit }, (_, i) => ({
        source: 'hitomi' as const,
        galleryId: `smart-${slug(query)}-${i}`,
        title: `Smart ${i}`,
        tags: ['elf'],
        artists: [`Artist ${slug(query)} ${i}`],
        parodies: ['blue archive'],
        language: 'japanese',
      }));
    },
  };

  const set = await recs.refreshRecommendations();
  assert.equal(set.items.length, 12);
  assert.ok(!queries.some(q => q.query.includes('sole_female') || q.query.includes('mosaic_censorship')), 'boilerplate tags must not be queried');
  assert.ok(queries.some(q => q.query.includes('series:blue_archive')), 'persisted parody should drive series query');
  assert.ok(queries.some(q => q.query.includes('female:elf') && q.query.includes('female:stockings')), 'co-occurring tag pair should be queried');
  assert.ok(queries.every(q => q.opts?.wrapSkip === true), 'wrapSkip must be passed to Hitomi search');
  assert.ok(queries.every(q => q.opts?.language === undefined || q.opts.language === 'japanese'), 'dominant language should be forwarded via opts.language');
  assert.ok(set.items.some(item => item.reasons.includes('series blue archive')), 'hydrated parodies should be credited in reasons');
});

test('active downloads, unreviewed Following finds, and known library duplicates are excluded from recommendations', async () => {
  const db = getDb();
  db.delete(schema.recommendationHistory).run();
  db.delete(schema.downloadQueue).run();
  db.delete(schema.watchedSearchNew).run();
  db.insert(schema.downloadQueue).values({ source: 'hitomi', galleryId: 'in-flight-1', title: 'Queued', status: 'queued' }).run();
  db.insert(schema.watchedSearchNew).values({
    searchId: 1, source: 'hitomi', query: 'artist:x', watchLabel: 'x', galleryId: 'inbox-1', title: 'In Inbox', foundAt: new Date().toISOString(),
  }).run();
  // Cross-source nHentai download already owned with same title + artist + page count.
  db.insert(schema.ownedGalleries).values({ source: 'nhentai', galleryId: 'nh-owned-1' }).onConflictDoNothing().run();
  db.insert(schema.keyValueStore).values({
    key: 'duplicate-gallery:nhentai:nh-owned-1',
    valueJson: JSON.stringify({ source: 'nhentai', galleryId: 'nh-owned-1', title: 'Duplicate Work Title', artists: ['Dup Artist'], language: 'english', pageCount: 28 }),
  }).onConflictDoUpdate({
    target: schema.keyValueStore.key,
    set: { valueJson: JSON.stringify({ source: 'nhentai', galleryId: 'nh-owned-1', title: 'Duplicate Work Title', artists: ['Dup Artist'], language: 'english', pageCount: 28 }) },
  }).run();

  const { eligibleRecommendations } = await import('../src/services/recommendationEligibility.js');
  const filtered = await eligibleRecommendations([
    { source: 'hitomi', galleryId: 'in-flight-1', title: 'Queued', artists: ['A'], tags: [] },
    { source: 'hitomi', galleryId: 'inbox-1', title: 'In Inbox', artists: ['B'], tags: [] },
    { source: 'hitomi', galleryId: 'dup-hitomi-1', title: 'Duplicate Work Title', artists: ['Dup Artist'], tags: [], language: 'english', pageCount: 28 },
    { source: 'hitomi', galleryId: 'clean-1', title: 'Brand New Work', artists: ['Fresh Artist'], tags: [], language: 'english', pageCount: 24 },
  ]);
  assert.deepEqual(filtered.map(i => i.galleryId), ['clean-1']);
});

test('unreachable galleries back off instead of being re-requested on every refresh', async () => {
  const db = getDb();
  db.delete(schema.downloadQueue).run();
  db.insert(schema.downloadQueue).values({ source: 'nhentai', galleryId: 'deleted-gallery', title: 'Gone', status: 'completed' }).run();
  let requests = 0;
  doujinProviders.nhentai = {
    ...originals.nhentai,
    async getGallery() {
      requests++;
      throw new Error('HTTP 404');
    },
  };
  doujinProviders.hitomi = stubProvider('hitomi', () => []);
  await recs.refreshRecommendations();
  await recs.refreshRecommendations();
  assert.equal(requests, 1);
  doujinProviders.nhentai = originals.nhentai;
});
