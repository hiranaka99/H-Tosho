import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { eq } from 'drizzle-orm';

// Isolated DB before the db module loads.
process.env.HTOSHO_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'htosho-fixes-'));

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const { initDb, getDb, schema } = await import('../src/db/index.js');
initDb();

const { fetchJson } = await import('../src/lib/http.js');
const { isJobType, jobQueue } = await import('../src/jobs/queue.js');
const { testNotification } = await import('../src/notify/dispatcher.js');
const { getDownloaderSettings, getNotificationSettings, onPollIntervalChange, parseDownloaderSettings, parseNotificationSettings, setNotificationSettings, setPollIntervalHours } = await import('../src/services/settings.js');
const { anilistProvider } = await import('../src/providers/anilist.js');
const { mediaRouter, mediaProxyUrl } = await import('../src/routes/media.js');
const { enqueueMatchForNewSeries } = await import('../src/services/sync.js');
const { autoMatch } = await import('../src/match/autoMatcher.js');
const { titleSearchParts } = await import('../src/match/normalize.js');
const { api } = await import('../src/routes/api.js');

describe('fetchJson error contract', () => {
  it('throws on non-2xx by default', async () => {
    globalThis.fetch = (async () => Response.json({ error: 'boom' }, { status: 500 })) as typeof fetch;
    await assert.rejects(() => fetchJson('https://example.com/x'), /HTTP 500/);
  });

  it('returns the response when raw is set', async () => {
    globalThis.fetch = (async () => Response.json({ error: 'boom' }, { status: 429 })) as typeof fetch;
    const res = await fetchJson<{ error: string }>('https://example.com/x', {}, 5_000, { raw: true });
    assert.equal(res.status, 429);
    assert.deepEqual(res.data, { error: 'boom' });
  });

  it('strips query strings from the thrown URL (no credential leak)', async () => {
    globalThis.fetch = (async () => new Response('nope', { status: 400 })) as typeof fetch;
    await assert.rejects(
      () => fetchJson('https://example.com/api/Image/series-cover?seriesId=1&apiKey=SECRET'),
      (e: Error) => e.message.includes('HTTP 400') && !e.message.includes('SECRET'),
    );
  });
});

describe('notification settings validation', () => {
  it('returns full defaults for malformed stored rows', () => {
    getDb()
      .insert(schema.keyValueStore)
      .values({ key: 'notifications', valueJson: '{"discord":{"enabled":true}}' })
      .onConflictDoUpdate({ target: schema.keyValueStore.key, set: { valueJson: '{"discord":{"enabled":true}}' } })
      .run();
    const s = getNotificationSettings();
    assert.deepEqual(s, { discord: { enabled: false, webhookUrl: '' } });
  });

  it('rejects wrong shapes in parseNotificationSettings', () => {
    assert.equal(parseNotificationSettings(null), null);
    assert.equal(parseNotificationSettings({}), null);
    assert.equal(parseNotificationSettings({ discord: { enabled: true } }), null);
    const ok = parseNotificationSettings({ discord: { enabled: true, webhookUrl: 'https://x' } });
    assert.ok(ok);
  });
});

describe('downloader settings persistence', () => {
  it('saves the submitted output directory', async () => {
    const downloadDirectory = path.join(process.env.HTOSHO_DATA_DIR!, 'downloads');
    const res = await api.request('/settings/downloader', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        downloadDirectory,
        format: 'cbz',
        maxConcurrentDownloads: 2,
        maxImageConcurrency: 4,
        requestDelayMs: 150,
        autoSyncKavita: false,
        nhentaiApiKey: '',
        nhentaiBannedTags: [],
      }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).settings.downloadDirectory, downloadDirectory);

    const stored = await api.request('/settings/downloader');
    assert.equal((await stored.json()).downloadDirectory, downloadDirectory);
  });

  it('rejects malformed and out-of-range downloader settings', async () => {
    const base = {
      downloadDirectory: path.join(process.env.HTOSHO_DATA_DIR!, 'downloads'),
      format: 'cbz',
      maxConcurrentDownloads: 2,
      maxImageConcurrency: 4,
      requestDelayMs: 150,
      autoSyncKavita: false,
      nhentaiApiKey: '',
      nhentaiBannedTags: [],
    };
    assert.equal(parseDownloaderSettings({ ...base, format: 'rar' }), null);
    assert.equal(parseDownloaderSettings({ ...base, maxConcurrentDownloads: 11 }), null);
    assert.equal(parseDownloaderSettings({ ...base, maxImageConcurrency: 0 }), null);
    assert.equal(parseDownloaderSettings({ ...base, requestDelayMs: -1 }), null);

    const res = await api.request('/settings/downloader', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...base, maxImageConcurrency: 1000 }),
    });
    assert.equal(res.status, 400);
  });

  it('falls back to defaults when stored downloader settings are malformed', () => {
    getDb()
      .insert(schema.keyValueStore)
      .values({ key: 'downloader', valueJson: JSON.stringify({ downloadDirectory: 'x', maxImageConcurrency: 1000 }) })
      .onConflictDoUpdate({ target: schema.keyValueStore.key, set: { valueJson: JSON.stringify({ downloadDirectory: 'x', maxImageConcurrency: 1000 }) } })
      .run();
    assert.equal(getDownloaderSettings().maxImageConcurrency, 4);
  });
});

describe('runtime settings hooks', () => {
  it('notifies the scheduler when the poll interval changes', () => {
    let notifications = 0;
    const unsubscribe = onPollIntervalChange(() => { notifications++; });
    setPollIntervalHours(3);
    unsubscribe();
    setPollIntervalHours(4);
    assert.equal(notifications, 1);
  });
});

describe('job request validation', () => {
  it('rejects unsupported job types before enqueueing', async () => {
    assert.equal(isJobType('scan-new'), true);
    assert.equal(isJobType('not-a-job'), false);
    const res = await api.request('/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'not-a-job' }),
    });
    assert.equal(res.status, 400);
  });
});

describe('dispatcher status handling', () => {
  it('reports a bad Discord webhook as a failure, not ok', async () => {
    setNotificationSettings({ discord: { enabled: true, webhookUrl: 'https://discord.com/api/webhooks/bad' } });
    globalThis.fetch = (async () => new Response('forbidden', { status: 403 })) as typeof fetch;
    const out = await testNotification();
    assert.match(out.discord, /HTTP 403/);
  });

  it('tests submitted notification settings without persisting them', async () => {
    setNotificationSettings({ discord: { enabled: false, webhookUrl: '' } });
    let requested = '';
    globalThis.fetch = (async (input) => {
      requested = String(input);
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const res = await api.request('/settings/notifications/test', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ notifications: { discord: { enabled: true, webhookUrl: 'https://discord.com/api/webhooks/draft' } } }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).discord, 'ok');
    assert.equal(requested, 'https://discord.com/api/webhooks/draft');
    assert.equal(getNotificationSettings().discord.enabled, false);
  });

  it('retries once after Retry-After on 429', async () => {
    setNotificationSettings({ discord: { enabled: true, webhookUrl: 'https://discord.com/api/webhooks/rate' } });
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) return new Response('rate limited', { status: 429, headers: { 'retry-after': '1' } });
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const out = await testNotification();
    assert.equal(out.discord, 'ok');
    assert.equal(calls, 2);
  });

});

describe('job queue fixes', () => {
  function insertJob(status: string): number {
    const res = getDb()
      .insert(schema.jobs)
      .values({ type: 'scan-new', payloadJson: '{}', status })
      .run();
    return Number(res.lastInsertRowid);
  }

  it('active() includes queued and running jobs', () => {
    const q = insertJob('queued');
    const r = insertJob('running');
    insertJob('completed');
    const ids = jobQueue.active().map((j) => j.id);
    assert.ok(ids.includes(q));
    assert.ok(ids.includes(r));
  });

  it('cancel of a just-claimed queued job falls back to the checkpoint path', () => {
    const id = insertJob('queued');
    // Simulate claimNext racing ahead: the row is running by the time cancel runs.
    getDb().update(schema.jobs).set({ status: 'running' }).where(eq(schema.jobs.id, id)).run();
    assert.equal(jobQueue.cancel(id), true);
    assert.equal(jobQueue.isCancelRequested(id), true);
  });

  it('cancel of a finished job returns false', () => {
    const id = insertJob('completed');
    assert.equal(jobQueue.cancel(id), false);
  });
});

describe('new-series matching trigger', () => {
  // No real handler is needed; a stub keeps enqueued jobs from failing.
  jobQueue.registerHandler(async () => ({}));

  const seriesList = (ids: number[]) =>
    ids.map((id) => ({ id, libraryId: 7, name: `S${id}`, slug: String(id), bookCount: 0 }));

  it('enqueues a match job only for series new to Kavita and H-Tosho', async () => {
    // 101 was already processed (row exists); 102 was in the pre-rescan snapshot; 103 is brand new.
    getDb().insert(schema.seriesMatches).values({ kavitaSeriesId: 101, status: 'matched' }).run();
    const fresh = await enqueueMatchForNewSeries({ getSeries: async () => seriesList([101, 102, 103]) }, 7, new Set([102]));
    assert.deepEqual(fresh, [103]);
    const job = jobQueue.list().find((j) => j.type === 'match-series' && (j.payload.seriesIds ?? []).includes(103));
    assert.ok(job);
    assert.deepEqual(job!.payload.seriesIds, [103]);
  });

  it('enqueues nothing when the rescan adds no unknown series', async () => {
    const fresh = await enqueueMatchForNewSeries({ getSeries: async () => seriesList([201]) }, 7, new Set([201]));
    assert.deepEqual(fresh, []);
  });
});

describe('autoMatch candidate dedup', () => {
  it('collapses the same title returned by repeated provider searches', async () => {
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      if (url.startsWith('https://api.mangadex.org/manga?')) {
        return Response.json({
          result: 'ok',
          response: 'collection',
          data: [
            { id: 'dup-1', attributes: { title: { en: 'Gamma' }, year: 2025, description: { en: 'live desc' } }, relationships: [] },
          ],
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    // The full name scores nothing usable, so the fallback re-searches each
    // separator-delimited part — every search returns the same manga.
    const outcome = await autoMatch({ id: 1, name: 'Alpha - Beta' }, {
      providerOrder: ['mangadex'],
      credentials: {},
      enabledProviders: ['mangadex'],
    });

    assert.equal(outcome.candidates.filter((c) => c.providerSeriesId === 'dup-1').length, 1);
  });

  it('breaks exact score ties by token overlap with the series name', async () => {
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      if (url.startsWith('https://api.mangadex.org/manga?')) {
        return Response.json({
          result: 'ok',
          response: 'collection',
          data: [
            // Lower overlap listed first: must not win the 0.92 tie by position.
            { id: 'low-1', attributes: { title: { en: 'Romance 101' }, year: 2018, description: { en: 'd' } }, relationships: [] },
            { id: 'high-1', attributes: { title: { en: 'The Quintessential Quintuplets - A Fifth of Romance (Doujinshi)' }, year: 2024, description: { en: 'd' } }, relationships: [] },
          ],
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    const outcome = await autoMatch({ id: 1, name: 'A Fifth of Romance' }, {
      providerOrder: ['mangadex'],
      credentials: {},
      enabledProviders: ['mangadex'],
    });

    assert.equal(outcome.best?.providerSeriesId, 'high-1');
  });
});

describe('autoMatch fallback search for compound names', () => {
  it('retries separator-delimited parts when the full name matches nothing, scoring title variants', async () => {
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      if (!url.startsWith('https://api.mangadex.org/manga?')) throw new Error(`Unexpected fetch: ${url}`);
      // The fallback part "Aizome" surfaces the real title: no English main
      // title, only a romanized one plus an English altTitle.
      if (url.includes('title=Aizome&')) {
        return Response.json({
          result: 'ok',
          response: 'collection',
          data: [
            {
              id: 'aizome-1',
              attributes: {
                title: { 'ja-ro': 'Aizome' },
                altTitles: [{ en: 'Filled with LOVE' }],
                year: 2020,
                description: { en: 'd' },
              },
              relationships: [],
            },
          ],
        });
      }
      // Full name and the other parts return only unrelated titles.
      return Response.json({
        result: 'ok',
        response: 'collection',
        data: [
          { id: 'noise-1', attributes: { title: { en: 'A Picky Eater Wants to Fill Her Stomach with Love' }, year: 2016, description: { en: 'd' } }, relationships: [] },
        ],
      });
    }) as typeof fetch;

    const outcome = await autoMatch({ id: 1, name: 'Aizome - Fill With LOVE' }, {
      providerOrder: ['mangadex'],
      credentials: {},
      enabledProviders: ['mangadex'],
    });

    assert.equal(outcome.matched, true);
    assert.equal(outcome.best?.providerSeriesId, 'aizome-1');
    // The displayed title is the variant matching the folder name (romanized),
    // not the picked English altTitle ("Filled with LOVE", which alone scores
    // below threshold).
    assert.equal(outcome.best?.title, 'Aizome');
  });

  it('splits compound names into search parts', () => {
    assert.deepEqual(titleSearchParts('Aizome - Fill With LOVE'), ['Aizome', 'Fill With LOVE']);
    assert.deepEqual(titleSearchParts('Title: Subtitle'), ['Title', 'Subtitle']);
    assert.deepEqual(titleSearchParts('Plain Title'), ['Plain Title']);
    // Short parts are dropped; the list is capped at three.
    assert.deepEqual(titleSearchParts('x - Aizome'), ['Aizome']);
    assert.deepEqual(titleSearchParts('Alpha - Beta - Gamma - Delta'), ['Alpha', 'Beta', 'Gamma']);
  });
});

describe('AniList provider fixes', () => {
  it('queries Media by id without a MANGA type filter (NOVEL works)', async () => {
    let capturedQuery = '';
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}'));
      capturedQuery = String(body.query ?? '');
      return Response.json({
        data: {
          Media: {
            id: 42,
            title: { romaji: 'Some Novel' },
            format: 'NOVEL',
            coverImage: {},
            description: '<p>a novel</p>',
            averageScore: 80,
            startDate: { year: 2020 },
            genres: [],
            tags: [],
            studios: null,
            status: 'FINISHED',
          },
        },
      });
    }) as typeof fetch;

    const meta = await anilistProvider.getSeriesMetadata('42');
    assert.ok(!capturedQuery.includes('type: MANGA'), 'query must not hardcode the MANGA type');
    assert.equal(meta.title, 'Some Novel');
  });

  it('surfaces GraphQL errors instead of returning empty results', async () => {
    globalThis.fetch = (async () =>
      Response.json({ errors: [{ message: 'Field "foo" is not defined on type "Query"' }] })) as typeof fetch;
    await assert.rejects(() => anilistProvider.search('anything'), /GraphQL error/);
  });
});

describe('media proxy allowlist', () => {
  const app = mediaRouter();
  const u = (url: string): string => Buffer.from(url, 'utf8').toString('base64url');

  it('rejects non-allowlisted hosts and IP literals', async () => {
    globalThis.fetch = (async () => new Response('x')) as typeof fetch;
    assert.equal((await app.request(`/media?u=${u('http://169.254.169.254/latest/meta-data')}`)).status, 400);
    assert.equal((await app.request(`/media?u=${u('https://evil.example.com/x.png')}`)).status, 400);
    assert.equal((await app.request('/media?u=not-base64!!')).status, 400);
  });

  it('proxies allowlisted CDN hosts', async () => {
    globalThis.fetch = (async () => new Response('fakeimg', { status: 200, headers: { 'content-type': 'image/png' } })) as typeof fetch;
    const res = await app.request(`/media?u=${u('https://a1.gold-usergeneratedcontent.net/b1/abc.avif')}`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'fakeimg');
  });

  it('does not follow redirects to disallowed hosts', async () => {
    globalThis.fetch = (async () => new Response(null, { status: 302, headers: { location: 'https://evil.example.com/x' } })) as typeof fetch;
    const res = await app.request(`/media?u=${u('https://uploads.mangadex.org/covers/abc/1.png')}`);
    assert.equal(res.status, 502);
  });

  it('mediaProxyUrl produces a base64url target', () => {
    const proxied = mediaProxyUrl('https://uploads.mangadex.org/covers/abc/1.png');
    assert.equal(Buffer.from(proxied.slice('/media?u='.length), 'base64url').toString('utf8'), 'https://uploads.mangadex.org/covers/abc/1.png');
  });
});
