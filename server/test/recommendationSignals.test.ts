import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

process.env.HTOSHO_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'htosho-signals-'));
// Test module-loading boundary: settings/DB snapshot the isolated directory above.
const { setKavitaConnection } = await import('../src/services/settings.js');
const { buildKavitaSignals, invalidateRecommendationSeries } = await import('../src/services/recommendationSignals.js');

test('large libraries share the sample and a metadata edit refetches only its series', async () => {
  setKavitaConnection({ baseUrl: 'https://kavita.test', apiKey: 'secret' });
  const originalFetch = globalThis.fetch;
  const metadataCalls: number[] = [];
  let edited = false;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/api/Library/libraries')) return Response.json([{ id: 1, name: 'Large' }, { id: 2, name: 'Small' }]);
    if (url.includes('/api/Series/all-v2?')) {
      const body = JSON.parse(String(init?.body));
      const id = Number(body.statements[0].value);
      return Response.json(id === 1 ? Array.from({ length: 700 }, (_, i) => ({ id: i + 1, name: `Large ${i}`, libraryId: 1 })) : [{ id: 900, name: 'Small library title', libraryId: 2, pages: 40, pagesRead: 40, totalReads: 2, hasUserRated: true, userRating: 5 }]);
    }
    const match = /\/api\/Series\/metadata\?seriesId=(\d+)/.exec(url);
    if (match) {
      const id = Number(match[1]);
      metadataCalls.push(id);
      return Response.json({
        genres: [{ title: 'Action' }],
        tags: [{ title: id === 900 && edited ? 'new tag' : 'old tag' }],
        writers: [{ name: 'Writer One' }],
        pencillers: [{ name: 'Artist Two' }],
        inkers: [{ name: 'artist two' }],
        language: 'en',
        webLinks: id === 900 ? 'https://hitomi.la/galleries/555.html' : '',
      });
    }
    throw new Error(`Unexpected request ${url}`);
  };
  try {
    const first = await buildKavitaSignals();
    assert.equal(first.length, 600);
    const small = first.find((signal) => signal.name === 'Small library title');
    assert.ok(small);
    assert.deepEqual(small.artists, ['Artist Two', 'Writer One']);
    assert.equal(small.userRating, 5);
    assert.equal(small.pagesRead, 40);
    assert.equal(small.totalReads, 2);
    assert.equal(small.webLinks, 'https://hitomi.la/galleries/555.html');
    const before = metadataCalls.length;
    await buildKavitaSignals();
    assert.equal(metadataCalls.length, before);
    edited = true;
    invalidateRecommendationSeries(900);
    const updated = await buildKavitaSignals();
    assert.deepEqual(metadataCalls.slice(before), [900]);
    assert.deepEqual(updated.find((signal) => signal.name === 'Small library title')?.tags, ['Action', 'new tag']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
