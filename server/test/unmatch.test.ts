import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { eq } from 'drizzle-orm';

// Isolated DB before the db module loads (same module-boundary reason as
// syncApply.test.ts): DATA_DIR is a module-level const in db/index.js.
process.env.HTOSHO_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'htosho-unmatch-'));

const { initDb, getDb, schema } = await import('../src/db/index.js');
initDb();

const { setKavitaConnection } = await import('../src/services/settings.js');
const { api } = await import('../src/routes/api.js');

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubKavita(requests: Array<{ url: string; init?: RequestInit }> = []): void {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, init });
    const m = url.match(/\/api\/Series\/(\d+)$/);
    if (m) return Response.json({ id: Number(m[1]), libraryId: 1, name: `Series ${m[1]}`, sortName: `Series ${m[1]}` });
    if (url.includes('/api/Series/metadata?')) return Response.json({
      id: 1, seriesId: 7, summary: 'Provider summary', genres: [{ id: 1, title: 'Action' }], tags: [{ id: 2, title: 'Provider tag' }, { id: 3, title: 'User tag' }],
      writers: [{ id: 4, name: 'Provider Writer' }], coverArtists: [], publishers: [], characters: [], pencillers: [{ id: 5, name: 'Provider Artist' }], inkers: [], imprints: [], colorists: [], letterers: [], editors: [], translators: [], teams: [], locations: [],
      ageRating: 0, releaseYear: 2024, language: 'en', maxCount: 0, totalCount: 0, publicationStatus: 2, webLinks: 'https://provider.example',
      languageLocked: true, summaryLocked: true, ageRatingLocked: false, publicationStatusLocked: true, genresLocked: true, tagsLocked: true, writerLocked: true, characterLocked: false, coloristLocked: false, editorLocked: false, inkerLocked: false, imprintLocked: false, lettererLocked: false, pencillerLocked: true, publisherLocked: false, translatorLocked: false, teamLocked: false, locationLocked: false, coverArtistLocked: false, releaseYearLocked: true,
    });
    if (url.includes('/api/Series/volumes?')) return Response.json([{ id: 71, minNumber: 1, maxNumber: 1 }]);
    if (init?.method === 'POST') return Response.json({ ok: true });
    throw new Error('unexpected fetch in unmatch test: ' + url);
  }) as typeof fetch;
}

describe('DELETE /series/:id/match (manual unmatch)', () => {
  it('returns 503 when Kavita is not configured', async () => {
    const res = await api.request('/series/7/match', { method: 'DELETE' });
    assert.equal(res.status, 503);
  });

  it('removes H-Tosho metadata and covers before dropping the match', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    stubKavita(requests);
    setKavitaConnection({ baseUrl: 'http://kavita.test', apiKey: 'test-key' });
    getDb()
      .insert(schema.seriesMatches)
      .values({
        kavitaSeriesId: 7,
        status: 'matched',
        providerId: 'mangadex',
        providerSeriesId: 'md-1',
        matchScore: 0.9,
        metadataJson: JSON.stringify({
          providerId: 'mangadex', providerSeriesId: 'md-1', title: 'Provider title', summary: 'Provider summary',
          genres: ['Action'], tags: ['Provider tag'], writers: ['Provider Writer'], artists: ['Provider Artist'],
          year: 2024, language: 'en', status: 'COMPLETED', url: 'https://provider.example', volumeCovers: [{ number: 1, url: 'https://covers.example/1.jpg' }],
        }),
      })
      .run();
    getDb().insert(schema.syncHistory).values({
      kavitaSeriesId: 7,
      seriesTitle: 'Series 7',
      action: 'matched',
      detailsJson: JSON.stringify({ pushed: ['name', 'summary', 'genres', 'tags', 'writers', 'artists', 'releaseYear', 'language', 'publicationStatus', 'webLinks'], coverUpdated: true, volumeCoversUpdated: 1 }),
    }).run();

    const res = await api.request('/series/7/match', { method: 'DELETE' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, removed: true });
    assert.equal(getDb().select().from(schema.seriesMatches).where(eq(schema.seriesMatches.kavitaSeriesId, 7)).get(), undefined);

    const identity = requests.find((request) => request.url.endsWith('/api/Series/update'));
    assert.equal(JSON.parse(String(identity?.init?.body)).nameLocked, false);
    const metadataRequest = requests.find((request) => request.url.endsWith('/api/Series/metadata') && request.init?.method === 'POST');
    const metadata = JSON.parse(String(metadataRequest?.init?.body)).seriesMetadata;
    assert.equal(metadata.summary, '');
    assert.deepEqual(metadata.genres, []);
    assert.deepEqual(metadata.tags, [{ id: 3, title: 'User tag' }]);
    assert.deepEqual(metadata.writers, []);
    assert.deepEqual(metadata.pencillers, []);
    assert.equal(metadata.releaseYear, 0);
    assert.equal(metadata.language, '');
    assert.equal(metadata.publicationStatus, 0);
    assert.equal(metadata.webLinks, '');
    const coverResets = requests.filter((request) => request.url.includes('/api/Upload/'));
    assert.deepEqual(coverResets.map((request) => JSON.parse(String(request.init?.body))), [
      { id: 7, url: '', lockCover: false },
      { id: 71, url: '', lockCover: false },
    ]);
    assert.ok(requests.some((request) => request.url.endsWith('/api/Series/scan')));

    const history = getDb().select().from(schema.syncHistory).where(eq(schema.syncHistory.kavitaSeriesId, 7)).all();
    assert.equal(history.at(-1)?.action, 'unmatched');
  });

  it('is a no-op when the series has no match row', async () => {
    stubKavita();

    const res = await api.request('/series/8/match', { method: 'DELETE' });
    assert.equal(res.status, 200);
    // Only the successful unmatch above added history.
    assert.equal(getDb().select().from(schema.syncHistory).all().filter((entry) => entry.action === 'unmatched').length, 1);
  });

  it('rejects invalid series ids', async () => {
    stubKavita();
    const res = await api.request('/series/abc/match', { method: 'DELETE' });
    assert.equal(res.status, 400);
  });
});
