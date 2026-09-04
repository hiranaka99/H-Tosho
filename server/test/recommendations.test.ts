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

function historyRows(): { key: string; date: string }[] {
  const row = getDb().select().from(schema.keyValueStore).all().find((r) => r.key === 'recommendations-history');
  assert.ok(row, 'history row missing');
  return JSON.parse(row.valueJson);
}

function writeHistoryRows(history: { key: string; date: string; item: unknown }[]): void {
  getDb()
    .update(schema.keyValueStore)
    .set({ valueJson: JSON.stringify(history) })
    .where(eq(schema.keyValueStore.key, 'recommendations-history'))
    .run();
}

// Taste profile: two artists + two tags across five "downloaded" galleries.
for (let i = 0; i < 3; i++) {
  recs.recordGalleryTags('hitomi', { source: 'hitomi', galleryId: `dl${i}`, title: `DL ${i}`, pages: [], artists: ['alpha', 'beta'], tags: ['vanilla', 'romance'] });
}
for (let i = 0; i < 2; i++) {
  recs.recordGalleryTags('nhentai', { source: 'nhentai', galleryId: `dl${i}`, title: `DL ${i}`, pages: [], artists: ['alpha'], tags: ['vanilla'] });
}

test('refreshes never re-serve picks, across refreshes and across days', async () => {
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
  assert.equal(set1.mode, 'library');
  // Popular fallback may top the set up (the tiny profile saturates its term
  // caps), but library matches with profile reasons must be present.
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
  let callsAfterFirst = -1;
  const trackedFirst = first.then((set) => { callsAfterFirst = searchCalls; return set; });
  releaseGate!();
  const [set1, set2] = await Promise.all([trackedFirst, second]);
  assert.equal(set1.items.length, 12);
  assert.equal(set2.items.length, 12);
  assert.ok(searchCalls > callsAfterFirst, 'refresh joined the in-flight generation instead of running its own roll');
  assert.equal(overlap(keySet(set1.items), keySet(set2.items)), 0, 'second roll re-served picks from the first');
});

test('empty generation is not cached and backs off until a manual refresh', async () => {
  // Fresh boundary: no history to recycle into the (would-be) set.
  getDb().delete(schema.keyValueStore).where(eq(schema.keyValueStore.key, 'recommendations-history')).run();
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
  assert.ok(
    !getDb().select().from(schema.keyValueStore).all().some((r) => r.key === `recommendations-v2:${today}`),
    'empty set was pinned to the day cache',
  );

  // While the sources stay down, subsequent reads must not re-run the pipeline.
  const callsAfterFirst = searchCalls;
  const set2 = await recs.getRecommendations();
  assert.equal(set2.items.length, 0);
  assert.equal(searchCalls, callsAfterFirst, 'empty-set cooldown did not prevent regeneration');

  // A manual refresh bypasses the cooldown and re-rolls.
  const set3 = await recs.refreshRecommendations();
  assert.equal(set3.items.length, 0);
  assert.ok(searchCalls > callsAfterFirst, 'manual refresh did not regenerate during the cooldown');
});

test('same-day exhaustion goes short instead of re-serving today\'s picks', async () => {
  // Fresh install boundary: drop the history left by the previous tests.
  getDb().delete(schema.keyValueStore).where(eq(schema.keyValueStore.key, 'recommendations-history')).run();

  // Twenty-four galleries shared by every query — exactly two full sets, so
  // the third refresh has no fresh candidates left.
  const shared = () => Array.from({ length: 24 }, (_, i) => String(i));
  doujinProviders.hitomi = stubProvider('hitomi', shared);
  const set1 = await recs.refreshRecommendations();
  assert.equal(set1.items.length, 12);
  const set2 = await recs.refreshRecommendations();
  assert.equal(set2.items.length, 12);
  assert.equal(overlap(keySet(set2.items), keySet(set1.items)), 0, 'second refresh re-served picks while fresh candidates remained');

  // No fresh candidates and no older history: the panel goes short rather than
  // repeating what the user already saw today.
  const set3 = await recs.refreshRecommendations();
  assert.equal(set3.items.length, 0, 'same-day picks were re-served after the fresh pool was exhausted');
});

test('exhausted pool recycles previously-served picks from earlier days, never today\'s', async () => {
  getDb().delete(schema.keyValueStore).where(eq(schema.keyValueStore.key, 'recommendations-history')).run();

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
    item: { source: 'hitomi', galleryId: `old-${i}`, title: `Old ${i}`, tags: [], artists: [], reasons: [] as string[] },
  }));
  writeHistoryRows([...older, ...historyRows()]);

  // Fresh pool exhausted → tops up from the oldest entries, which are yesterday's.
  const set3 = await recs.refreshRecommendations();
  assert.equal(set3.items.length, 12);
  const servedToday = keySet([...set1.items, ...set2.items]);
  for (const it of set3.items) {
    const k = `${it.source}:${it.galleryId}`;
    assert.ok(!servedToday.has(k), `same-day re-serve: ${k}`);
    assert.ok(k.startsWith('hitomi:old-'), `expected a recycled older pick, got ${k}`);
  }

  // Re-serving a recycled pick refreshes its exclusion window.
  const today = localDate(new Date());
  assert.ok(historyRows().every((h) => h.date === today), 'history kept stale serve dates after recycling');
});

test('repeated refreshes rotate through a static ranking via seeded skips', async () => {
  getDb().delete(schema.keyValueStore).where(eq(schema.keyValueStore.key, 'recommendations-history')).run();

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
