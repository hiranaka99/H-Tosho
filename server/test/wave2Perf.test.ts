import assert from 'node:assert/strict';
import fs, { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';

const dataDir = mkdtempSync(path.join(tmpdir(), 'htosho-wave2-perf-'));
process.env.HTOSHO_DATA_DIR = dataDir;

const { initDb, closeDb, getDb, schema } = await import('../src/db/index.js');
initDb();

const { fetchCandidatesToFileWithRetry } = await import('../src/downloader/requests.js');
const { buildZipFromFiles } = await import('../src/downloader/zip.js');
const { readZipEntries, readZipEntry } = await import('../src/lib/cbz.js');
const { canonicalTitle, levenshtein, scoreCanonical } = await import('../src/match/normalize.js');
const { canBatchProviderMetadata } = await import('../src/match/autoMatcher.js');
const { AniListProvider } = await import('../src/providers/anilist.js');
const { mangaDexProvider } = await import('../src/providers/mangadex.js');
const { setWatchedSearchIntervalMinutes } = await import('../src/services/settings.js');
const {
  addWatchedSearch,
  nextWatchedSearchDueAt,
  onWatchedScheduleChange,
  removeWatchedSearch,
  rescheduleWatchedSearches,
  updateWatchedSearch,
} = await import('../src/services/watchedSearches.js');

function referenceLevenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  let curr = Array.from<number>({ length: b.length + 1 });
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

after(() => {
  closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('Wave 2 backend performance primitives', () => {
  test('fetchCandidatesToFileWithRetry skips permanently failing mirrors on subsequent rounds while retrying transient ones', async () => {
    const tmpDir = mkdtempSync(path.join(dataDir, 'mirrors-'));
    const dest = path.join(tmpDir, '001.png');
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    let mirror2Attempts = 0;

    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('/mirror1')) {
        return new Response('missing', { status: 404 });
      }
      if (url.includes('/mirror2')) {
        mirror2Attempts++;
        if (mirror2Attempts === 1) {
          return new Response('slow down', { status: 429, headers: { 'retry-after': '0' } });
        }
        return new Response(pngBytes, { status: 200, headers: { 'content-type': 'image/png' } });
      }
      throw new Error(`Unexpected mirror URL: ${url}`);
    }) as typeof fetch;

    try {
      const res = await fetchCandidatesToFileWithRetry(
        ['https://cdn.test/mirror1', 'https://cdn.test/mirror2'],
        {},
        dest,
        {},
      );
      assert.equal(res.index, 1);
      assert.equal(res.url, 'https://cdn.test/mirror2');
      assert.equal(res.bytes, pngBytes.length);
      assert.deepEqual(calls, [
        'https://cdn.test/mirror1',
        'https://cdn.test/mirror2',
        'https://cdn.test/mirror2',
      ]);
      assert.deepEqual(fs.readFileSync(dest), Buffer.from(pngBytes));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('levenshtein, canonicalTitle, and scoreCanonical match exact reference semantics across edge cases', () => {
    const pairs: [string, string][] = [
      ['', ''],
      ['', 'abc'],
      ['abc', ''],
      ['same-prefix-alpha-tail', 'same-prefix-beta-tail'],
      ['abc', 'axcy'],
      ['cafe\u0301', 'café'],
      ['kimetsu no yaiba', 'kimetsu yaiba'],
      ['short title', 'the short title volume 3'],
    ];
    for (const [a, b] of pairs) {
      assert.equal(levenshtein(a, b), referenceLevenshtein(a, b), `levenshtein mismatch for (${a}, ${b})`);
      assert.equal(levenshtein(b, a), referenceLevenshtein(b, a), `levenshtein symmetry mismatch for (${b}, ${a})`);
    }
    assert.equal(canonicalTitle('Café Story Vol. 2'), canonicalTitle('Cafe Story (12)'));
    assert.equal(scoreCanonical(canonicalTitle('Alpha Beta'), canonicalTitle('Beta Alpha Gamma')), 0.92);
    assert.equal(scoreCanonical('', canonicalTitle('Anything')), 0);
  });

  test('canBatchProviderMetadata distinguishes prototype batch support from monkey-patched instances', () => {
    const protoProvider = new AniListProvider();
    assert.equal(canBatchProviderMetadata(protoProvider), true);

    const mockedSingle = new AniListProvider();
    mockedSingle.getSeriesMetadata = async () => {
      throw new Error('mocked');
    };
    assert.equal(canBatchProviderMetadata(mockedSingle), false);

    mockedSingle.getSeriesMetadataBatch = async () => new Map();
    assert.equal(canBatchProviderMetadata(mockedSingle), true);
  });

  test('AniListProvider.getSeriesMetadataBatch chunks requests and maps results by ID', async () => {
    const postPayloads: Record<string, unknown>[] = [];
    const provider = new AniListProvider({
      post: async <T>(payload: { query: string; variables: Record<string, unknown> }) => {
        postPayloads.push(payload.variables);
        const ids = (payload.variables.ids as number[]) ?? [];
        return {
          status: 200,
          data: {
            data: {
              Page: {
                media: ids.map((id) => ({
                  id,
                  title: { romaji: `Series ${id}`, english: `Series EN ${id}` },
                  synonyms: [],
                  format: 'MANGA',
                  coverImage: { extraLarge: `https://img.test/${id}.jpg` },
                  description: '<p>Desc</p>',
                  averageScore: 80,
                  startDate: { year: 2022, month: 4, day: 1 },
                  genres: ['Action'],
                  tags: [{ name: 'School', userId: 1 }],
                  studios: null,
                  status: 'FINISHED',
                })),
              },
            },
          } as T,
        };
      },
    } as never);

    const ids = Array.from({ length: 55 }, (_, i) => String(i + 1));
    ids.push('not-a-number', '1');
    const result = await provider.getSeriesMetadataBatch(ids);
    assert.equal(result.size, 55);
    assert.equal(postPayloads.length, 2);
    assert.equal((postPayloads[0].ids as number[]).length, 50);
    assert.equal((postPayloads[1].ids as number[]).length, 5);
    assert.equal(result.get('55')?.title, 'Series 55');
    assert.equal(result.get('55')?.status, 'COMPLETED');
  });

  test('MangaDexProvider.getSeriesMetadataBatch requests all content ratings and honors skipVolumeCovers', async () => {
    const originalGet = (mangaDexProvider as unknown as { get: (path: string, init?: RequestInit) => Promise<unknown> }).get;
    const requestedPaths: string[] = [];
    (mangaDexProvider as unknown as { get: (path: string, init?: RequestInit) => Promise<unknown> }).get = async (reqPath: string) => {
      requestedPaths.push(reqPath);
      if (reqPath.startsWith('/manga?')) {
        return {
          data: [
            {
              id: 'md-1',
              attributes: {
                title: { en: 'First Title' },
                altTitles: [],
                description: { en: 'Body text' },
                tags: [{ attributes: { name: { en: 'Drama' }, group: 'genre' } }],
                status: 'ongoing',
                originalLanguage: 'ja',
              },
              relationships: [{ id: 'c1', type: 'cover_art', attributes: { fileName: 'main1.jpg' } }],
            },
            {
              id: 'md-2',
              attributes: {
                title: { en: 'Second Title' },
                altTitles: [],
                description: { en: 'Protected cover series' },
                tags: [],
                status: 'completed',
                originalLanguage: 'en',
              },
              relationships: [{ id: 'c2', type: 'cover_art', attributes: { fileName: 'main2.jpg' } }],
            },
          ],
        };
      }
      if (reqPath.startsWith('/cover?manga%5B%5D=md-1')) {
        return {
          response: 'collection',
          data: [{ id: 'v1', attributes: { volume: '1', fileName: 'vol1.jpg', locale: 'en' } }],
        };
      }
      throw new Error(`Unexpected MangaDex path: ${reqPath}`);
    };

    try {
      const result = await mangaDexProvider.getSeriesMetadataBatch(['md-1', 'md-2'], undefined, {
        skipVolumeCovers: new Set(['md-2']),
      });
      assert.equal(result.size, 2);
      assert.equal(result.get('md-1')?.coverUrl, 'https://uploads.mangadex.org/covers/md-1/vol1.jpg');
      assert.equal(result.get('md-2')?.coverUrl, 'https://uploads.mangadex.org/covers/md-2/main2.jpg');
      const mangaReq = requestedPaths.find((p) => p.startsWith('/manga?'))!;
      for (const rating of ['safe', 'suggestive', 'erotica', 'pornographic']) {
        assert.ok(mangaReq.includes(`contentRating%5B%5D=${rating}`), `missing contentRating ${rating}`);
      }
      assert.equal(requestedPaths.some((p) => p.includes('md-2') && p.startsWith('/cover?')), false);
    } finally {
      (mangaDexProvider as unknown as { get: (path: string, init?: RequestInit) => Promise<unknown> }).get = originalGet;
    }
  });

  test('nextWatchedSearchDueAt and onWatchedScheduleChange track due timestamps and schedule changes', () => {
    getDb().delete(schema.watchedSearches).run();
    setWatchedSearchIntervalMinutes(15);
    let notifications = 0;
    const unsub = onWatchedScheduleChange(() => { notifications++; });
    try {
      assert.equal(nextWatchedSearchDueAt(), null);
      const w1 = addWatchedSearch('hitomi', 'artist:schedule_a');
      const w2 = addWatchedSearch('hitomi', 'artist:schedule_b');
      assert.ok(notifications >= 2);
      const due = nextWatchedSearchDueAt(0);
      assert.ok(typeof due === 'number' && due > 0);

      const paused = updateWatchedSearch(w1.id, { expectedRevision: w1.revision, paused: true });
      assert.equal(paused.pausedAt !== null, true);
      updateWatchedSearch(w2.id, { expectedRevision: w2.revision, paused: true });
      assert.equal(nextWatchedSearchDueAt(), null, 'all watches paused yields null');

      const resumed = updateWatchedSearch(w2.id, { expectedRevision: w2.revision + 1, paused: false });
      assert.ok(nextWatchedSearchDueAt(0) !== null);

      setWatchedSearchIntervalMinutes(0);
      assert.equal(nextWatchedSearchDueAt(0), null, 'disabled global cadence yields null');

      setWatchedSearchIntervalMinutes(15);
      rescheduleWatchedSearches();
      assert.ok(nextWatchedSearchDueAt(0) !== null);

      removeWatchedSearch(paused.id, paused.revision);
      removeWatchedSearch(resumed.id, resumed.revision);
      assert.equal(nextWatchedSearchDueAt(0), null);
    } finally {
      unsub();
      setWatchedSearchIntervalMinutes(15);
    }
  });

  test('buildZipFromFiles pipelines read-ahead reads into a readable CBZ and aborts cleanly', async () => {
    const zipDir = mkdtempSync(path.join(dataDir, 'zip-'));
    const inputFiles: { name: string; path: string; bytes: Buffer }[] = [];
    for (let i = 1; i <= 7; i++) {
      const name = `${String(i).padStart(3, '0')}.jpg`;
      const p = path.join(zipDir, name);
      const bytes = Buffer.from(`fake-jpeg-payload-${i}-` + 'x'.repeat(256));
      fs.writeFileSync(p, bytes);
      inputFiles.push({ name, path: p, bytes });
    }
    const comicInfo = Buffer.from('<ComicInfo><Title>Test</Title></ComicInfo>', 'utf8');
    const dest = path.join(zipDir, 'gallery.cbz');

    await buildZipFromFiles(
      inputFiles.map(({ name, path: p }) => ({ name, path: p })),
      dest,
      [{ name: 'ComicInfo.xml', data: comicInfo }],
    );

    const archive = fs.readFileSync(dest);
    const entries = readZipEntries(archive);
    assert.equal(entries.length, 8);
    for (const file of inputFiles) {
      assert.deepEqual(readZipEntry(archive, file.name), file.bytes);
    }
    assert.deepEqual(readZipEntry(archive, 'ComicInfo.xml'), comicInfo);

    const ac = new AbortController();
    ac.abort(new Error('Cancelled'));
    await assert.rejects(
      buildZipFromFiles(
        inputFiles.map(({ name, path: p }) => ({ name, path: p })),
        path.join(zipDir, 'aborted.cbz'),
        [],
        ac.signal,
      ),
      /Cancelled/,
    );
    assert.equal(fs.existsSync(path.join(zipDir, 'aborted.cbz')), false);
  });
});
