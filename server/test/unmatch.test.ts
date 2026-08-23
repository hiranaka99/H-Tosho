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

/** Stub the single Kavita call the endpoint makes (GET /api/Series/{id}). */
function stubKavita(): void {
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    const m = url.match(/\/api\/Series\/(\d+)$/);
    if (!m) throw new Error('unexpected fetch in unmatch test: ' + url);
    return Response.json({ id: Number(m[1]), libraryId: 1, name: `Series ${m[1]}` });
  }) as typeof fetch;
}

describe('DELETE /series/:id/match (manual unmatch)', () => {
  it('returns 503 when Kavita is not configured', async () => {
    const res = await api.request('/series/7/match', { method: 'DELETE' });
    assert.equal(res.status, 503);
  });

  it('drops the match row and records an unmatched history entry', async () => {
    stubKavita();
    setKavitaConnection({ baseUrl: 'http://kavita.test', apiKey: 'test-key' });
    getDb()
      .insert(schema.seriesMatches)
      .values({ kavitaSeriesId: 7, status: 'matched', providerId: 'mangadex', providerSeriesId: 'md-1', matchScore: 0.9 })
      .run();

    const res = await api.request('/series/7/match', { method: 'DELETE' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, removed: true });

    const row = getDb().select().from(schema.seriesMatches).where(eq(schema.seriesMatches.kavitaSeriesId, 7)).get();
    assert.equal(row, undefined);

    const history = getDb().select().from(schema.syncHistory).all();
    assert.equal(history.length, 1);
    assert.equal(history[0].kavitaSeriesId, 7);
    assert.equal(history[0].seriesTitle, 'Series 7');
    assert.equal(history[0].action, 'unmatched');
    const details = JSON.parse(history[0].detailsJson ?? '{}') as { providerId: string; matchScore: number };
    assert.equal(details.providerId, 'mangadex');
    assert.equal(details.matchScore, 0.9);
  });

  it('is a no-op when the series has no match row', async () => {
    stubKavita();

    const res = await api.request('/series/8/match', { method: 'DELETE' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, removed: false });
    // Only the history entry from the previous test exists.
    assert.equal(getDb().select().from(schema.syncHistory).all().length, 1);
  });

  it('rejects invalid series ids', async () => {
    stubKavita();
    const res = await api.request('/series/abc/match', { method: 'DELETE' });
    assert.equal(res.status, 400);
  });
});
