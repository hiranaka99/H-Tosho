import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { and, eq, sql } from 'drizzle-orm';

// Point the DB at a throwaway directory before the db module loads so the
// refresh engine runs against an isolated schema. The dynamic imports below
// are deliberate (module-loading boundary): DATA_DIR is a module-level const
// in db/index.js, so static imports would capture the real data directory.
process.env.HTOSHO_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'htosho-catalog-refresh-'));

const { initDb, getDb, schema } = await import('../src/db/index.js');
const { refreshCatalog, invalidateCatalogCache, catalogCandidates } = await import('../src/match/mangadexCatalog.js');

initDb();

/** One title in the fake MangaDex dataset. */
interface FakeItem {
  id: string;
  en: string;
  year: number | null;
  updatedAt: string;
}

let datasets: Record<string, FakeItem[]> = {};
const callCounts = new Map<string, number>();
/** URLs whose first hit returns a truncated page (simulates transient partial pages). */
const truncateOnce = new Set<string>();

function mangaUrl(rating: string, extra: Record<string, string>, offset: number): string {
  const p = new URLSearchParams();
  p.append('contentRating[]', rating);
  for (const [k, v] of Object.entries(extra)) p.set(k, v);
  p.set('limit', '50');
  p.set('offset', String(offset));
  return `https://api.mangadex.org/manga?${p.toString()}`;
}

globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(String(input));
  const key = url.pathname + url.search;
  callCounts.set(key, (callCounts.get(key) ?? 0) + 1);
  const rating = url.searchParams.get('contentRating[]') ?? 'suggestive';
  const yearParam = url.searchParams.get('year');
  const orderYear = url.searchParams.get('order[year]');
  const orderUpdated = url.searchParams.get('order[updatedAt]');
  const offset = Number(url.searchParams.get('offset') ?? '0');
  const limit = Number(url.searchParams.get('limit') ?? '50');

  let list = [...(datasets[rating] ?? [])];
  if (yearParam) list = list.filter((i) => i.year === Number(yearParam));
  // Null-year items sort last in year-ordered queries (Elasticsearch missing-last).
  if (orderYear === 'asc') list.sort((a, b) => (a.year ?? Infinity) - (b.year ?? Infinity));
  else if (orderUpdated === 'desc') list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  const total = list.length;
  let page = list.slice(offset, offset + limit);
  if (truncateOnce.has(key) && (callCounts.get(key) ?? 0) === 1 && page.length > 25) {
    page = page.slice(0, 25); // transient partial page on the first hit only
  }
  return Response.json({
    total,
    data: page.map((i) => ({
      id: i.id,
      attributes: {
        title: { en: i.en },
        altTitles: [],
        description: {},
        year: i.year ?? undefined,
        contentRating: rating,
        updatedAt: i.updatedAt,
      },
    })),
  });
}) as typeof fetch;

function makeItems(rating: string, years: number[], perYear: number, updatedAt = '2026-08-01T00:00:00Z'): FakeItem[] {
  const items: FakeItem[] = [];
  for (const y of years) {
    for (let i = 0; i < perYear; i++) {
      items.push({ id: `${rating}-${y}-${i}`, en: `${rating} series ${y}-${i}`, year: y, updatedAt });
    }
  }
  return items;
}

function resetDb(): void {
  const db = getDb();
  db.delete(schema.mangadexCatalog).run();
  db.delete(schema.keyValueStore).run();
  datasets = { suggestive: [], erotica: [], pornographic: [] };
  callCounts.clear();
  truncateOnce.clear();
  invalidateCatalogCache();
}

function countRows(rating: string): number {
  return (
    getDb()
      .select({ n: sql<number>`count(*)` })
      .from(schema.mangadexCatalog)
      .where(eq(schema.mangadexCatalog.contentRating, rating))
      .get()?.n ?? 0
  );
}

function readRecord(): { at: string; complete: Record<string, boolean>; perRating?: Record<string, { boundaryMs: number; minYear: number }> } {
  const row = getDb().select().from(schema.keyValueStore).where(eq(schema.keyValueStore.key, 'mangadex_catalog.last_refresh')).get();
  return JSON.parse(row!.valueJson);
}

describe('MangaDex catalog refresh engine', () => {
  it('full build indexes every titled year in full via per-year windows', async () => {
    resetDb();
    datasets.suggestive = makeItems('suggestive', [2020, 2021, 2022, 2023, 2024], 55);
    const r = await refreshCatalog({ log: () => {} });

    // All 275 items present — each year was paged exhaustively as its own window.
    assert.equal(countRows('suggestive'), 275);
    assert.equal(r.total, 275);
    const rec = readRecord();
    assert.equal(rec.complete.suggestive, true);
    assert.ok(rec.perRating!.suggestive!.boundaryMs > Date.now() - 60_000);
    assert.equal(rec.perRating!.suggestive!.minYear, 2020);
  });

  it('re-fetches a transiently truncated page instead of ending the sweep', async () => {
    resetDb();
    datasets.suggestive = makeItems('suggestive', [2021], 55);
    truncateOnce.add(mangaUrl('suggestive', { year: '2021' }, 0));
    await refreshCatalog({ log: () => {} });

    // Without the recheck, the sweep would stop at the first (truncated) page and keep only 25 of 55.
    assert.equal(countRows('suggestive'), 55);
  });

  it('incremental refresh picks up items updated since the last build', async () => {
    resetDb();
    datasets.suggestive = makeItems('suggestive', [2021], 55);
    await refreshCatalog({ log: () => {} }); // full build; boundary = now

    // Simulate post-build activity: two edits and one brand-new title.
    const now = new Date().toISOString();
    datasets.suggestive[0].updatedAt = now;
    datasets.suggestive[1].updatedAt = now;
    datasets.suggestive.push({ id: 'suggestive-new', en: 'brand new series', year: 2021, updatedAt: now });

    await refreshCatalog({ log: () => {} });
    assert.equal(countRows('suggestive'), 56); // the new title arrived via the delta window
    const rec = readRecord();
    assert.equal(rec.complete.suggestive, true);
    assert.ok(rec.perRating!.suggestive!.boundaryMs > 0);
  });

  it('year audit re-fetches years whose DB count drifted below the API total', async () => {
    resetDb();
    datasets.suggestive = makeItems('suggestive', [2021], 55);
    await refreshCatalog({ log: () => {} });

    // Simulate drift: lose 5 rows for the year (e.g. a truncated page in an earlier build).
    getDb()
      .delete(schema.mangadexCatalog)
      .where(and(eq(schema.mangadexCatalog.contentRating, 'suggestive'), eq(schema.mangadexCatalog.year, 2021)))
      .limit(5)
      .run();
    assert.equal(countRows('suggestive'), 50);

    await refreshCatalog({ log: () => {} });
    // Short by more than the tolerance → the year was re-fetched in full.
    assert.equal(countRows('suggestive'), 55);
  });
});

describe('catalog candidate eligibility', () => {
  it('unflagged series only get exact canonical matches; flagged series keep fuzzy candidates', () => {
    resetDb();
    const db = getDb();
    db.insert(schema.mangadexCatalog)
      .values([
        { mangaId: 'm1', titleEn: 'At Home Harem Fudeoro Sisters', originalTitle: null, altTitlesJson: '[]', descriptionEn: null, year: 2024, status: null, contentRating: 'suggestive', malId: null, alId: null, muId: null, mdUpdatedAt: '2026-08-01T00:00:00Z', fetchedAt: '2026-08-01T00:00:00Z' },
        { mangaId: 'm2', titleEn: 'Sisters of the Vale', originalTitle: null, altTitlesJson: '[]', descriptionEn: null, year: 2020, status: null, contentRating: 'suggestive', malId: null, alId: null, muId: null, mdUpdatedAt: '2026-08-01T00:00:00Z', fetchedAt: '2026-08-01T00:00:00Z' },
      ])
      .run();
    invalidateCatalogCache();

    // Exact canonical match (parenthetical suffixes are ignored) is eligible unflagged.
    const exact = catalogCandidates('At Home Harem Fudeoro Sisters (Decensored)', false);
    assert.equal(exact.length, 1);
    assert.equal(exact[0].providerSeriesId, 'm1');
    assert.equal(exact[0].score, 1);

    // A one-word name only containment-matches (0.92) → nothing eligible unflagged.
    assert.deepEqual(catalogCandidates('Sisters', false), []);

    // Flagged series keep the fuzzy candidates.
    const fuzzy = catalogCandidates('Sisters', true);
    assert.ok(fuzzy.length >= 2, `expected fuzzy candidates, got ${fuzzy.length}`);
  });
});
