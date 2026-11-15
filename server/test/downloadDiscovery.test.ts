import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { afterEach, beforeEach, test, type TestContext } from 'node:test';
import { eq } from 'drizzle-orm';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'htosho-download-discovery-'));
const output = path.join(dataDir, 'downloads');
process.env.HTOSHO_DATA_DIR = dataDir;
const { initDb, getDb, schema } = await import('../src/db/index.js');
const { DEFAULT_DOWNLOADER, setDownloaderSettings, setKavitaConnection, setProviderSetting, setLibraryOverride } = await import('../src/services/settings.js');
const { queueDownloadedMatchDiscovery } = await import('../src/services/downloadDiscovery.js');
const { listMatchSuggestions, rejectMatchCandidate } = await import('../src/services/matchSuggestions.js');
const { runJob } = await import('../src/jobs/executor.js');
const { jobQueue, JobCancelled } = await import('../src/jobs/queue.js');
const { DownloadQueue } = await import('../src/downloader/engine.js');
const { doujinProviders } = await import('../src/downloader/providers.js');
const { getProvider } = await import('../src/providers/registry.js');
const { parseJobCommand } = await import('../src/contracts/jobs.js');
const { api } = await import('../src/routes/api.js');
initDb();
const provider = getProvider('anilist')!;
const originalSearch = provider.search, originalFetch = globalThis.fetch, originalHitomi = doujinProviders.hitomi;
let downloadPath: string, remoteRoot: string, reportedFolder: string, grouped = false;
let statusReads = 0, seriesReads = 0, indexDelay = 0, providerDown = false, noMatch = false;
let searches: string[], requests: string[], scanBodies: { folderPath: string; abortOnNoSeriesMatch: boolean }[];

beforeEach(() => {
  setKavitaConnection({ baseUrl: 'https://kavita.test', apiKey: 'test' });
  const db = getDb();
  for (const table of [schema.jobLogs, schema.jobs, schema.matchSuggestions, schema.rejectedMatchCandidates, schema.seriesMatches, schema.syncHistory, schema.downloadQueue]) db.delete(table).run();
  setDownloaderSettings({ ...DEFAULT_DOWNLOADER, downloadDirectory: output, requestDelayMs: 0 });
  setLibraryOverride({ libraryId: 1, priority: ['anilist'], autoMatch: false });
  for (const id of ['anilist', 'mangadex', 'myanimelist']) setProviderSetting(id, { enabled: id === 'anilist' });
  downloadPath = path.join(output, 'Sample title', 'Sample.cbz');
  remoteRoot = output; reportedFolder = path.dirname(downloadPath); grouped = false;
  statusReads = 0; seriesReads = 0; indexDelay = 0; providerDown = false; noMatch = false;
  searches = []; requests = []; scanBodies = [];
  provider.search = async query => {
    searches.push(query);
    if (providerDown) throw new Error('Provider unavailable');
    return noMatch ? [] : [{ providerId: 'anilist', providerSeriesId: 'candidate', title: 'Sample title', type: 'MANGA' }];
  };
  doujinProviders.hitomi = { ...originalHitomi, getGallery: async id => ({ source: 'hitomi', galleryId: id, title: 'Sample title', artists: [], tags: [], pages: ['https://images.test/1.jpg'] }) };
  globalThis.fetch = (async (input, init) => {
    const url = String(input); requests.push(url);
    if (url.startsWith('https://images.test/')) return new Response(Buffer.from('image'));
    if (url.endsWith('/api/Library/libraries')) return Response.json([{ id: 1, name: 'Downloads', type: 0, folders: [remoteRoot] }]);
    if (url.endsWith('/api/Library/scan-folder')) { scanBodies.push(JSON.parse(String(init?.body))); return Response.json({}); }
    if (url.includes('/api/Server/is-task-running')) return Response.json(++statusReads <= 6);
    if (url.includes('/api/Series/all-v2')) {
      assert.ok(scanBodies.length > 0, 'Kavita must import the output before discovery');
      const target = { id: 1, libraryId: 1, name: 'Sample title', folderPath: reportedFolder, coverImage: 'cover.jpg' };
      return Response.json([
        { id: 99, libraryId: 1, name: 'Other unmatched title', folderPath: path.join(output, 'other') },
        ...(++seriesReads > indexDelay ? [target] : []),
        ...(grouped ? [{ ...target, id: 5, folderPath: '/other/same-name' }] : []),
      ]);
    }
    if (url.includes('/api/Search/chapters-by-series')) return Response.json([{ id: 1, files: [{ id: 1, filePath: url.endsWith('=1') ? downloadPath : path.join(output, 'not-this-download.cbz') }] }]);
    throw new Error(`Discovery must not apply metadata or fetch full provider metadata: ${url}`);
  }) as typeof fetch;
});
afterEach(() => { provider.search = originalSearch; globalThis.fetch = originalFetch; doujinProviders.hitomi = originalHitomi; });

async function clock<T>(t: TestContext, run: () => Promise<T>): Promise<T> {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  let done = false;
  const result = run().finally(() => { done = true; });
  void result.catch(() => {});
  for (let step = 0; step < 300; step++) {
    for (let flush = 0; flush < 12; flush++) await setImmediate();
    if (done) return result;
    t.mock.timers.tick(5_000);
  }
  assert.fail('Discovery did not settle within its indexing deadline');
}
const queued = () => jobQueue.get(queueDownloadedMatchDiscovery(downloadPath, 'Sample title')!)!;

test('completed CBZ and folder downloads queue discovery with either legacy auto-sync value, without blocking downloads', async () => {
  for (const format of ['cbz', 'folder'] as const) {
    const settings = { ...DEFAULT_DOWNLOADER, downloadDirectory: output, format, maxConcurrentDownloads: 1, requestDelayMs: 0, autoSyncKavita: format === 'folder' };
    const queue = new DownloadQueue(() => settings);
    const id = queue.enqueue('hitomi', `completed-${format}`, 'Sample title', format);
    await new Promise<void>(resolve => {
      const unsubscribe = queue.subscribe(task => { if (task.id === id && task.status === 'completed') { unsubscribe(); resolve(); } });
    });
    await setImmediate();
    const task = queue.get(id)!;
    assert.equal(task.status, 'completed');
    const discovery = jobQueue.active().find(job => job.type === 'scan-downloaded' && job.payload.path === task.outputPath)!;
    assert.ok(discovery, `The follow-up is persisted before the worker is needed: ${JSON.stringify(jobQueue.active())}`);
    assert.equal(discovery.payload.connectionKey, 'https://kavita.test');
  }
  assert.deepEqual(requests.filter(url => !url.startsWith('https://images.test/')), []);
  assert.deepEqual(searches, [], 'Queued discovery never occupies the download worker');
});

test('queued discovery survives cleared download history and imports only its folder before adding Home candidates', async t => {
  const queue = new DownloadQueue(() => ({ ...DEFAULT_DOWNLOADER, downloadDirectory: output, requestDelayMs: 0 }));
  const id = queue.enqueue('hitomi', 'end-to-end', 'Sample title', 'cbz');
  await new Promise<void>(resolve => {
    const unsubscribe = queue.subscribe(task => { if (task.id === id && task.status === 'completed') { unsubscribe(); resolve(); } });
  });
  await setImmediate();
  downloadPath = queue.get(id)!.outputPath!; reportedFolder = path.dirname(downloadPath);
  const job = jobQueue.active().find(item => item.type === 'scan-downloaded')!;
  queue.clearCompleted();
  indexDelay = 1;
  assert.equal((await (await api.request('/home/matches')).json()).scan.type, 'scan-downloaded');
  const result = await clock(t, () => runJob(job, () => {}));
  assert.deepEqual(result, { processed: 1, matchable: 1, failed: 0 });
  assert.equal(seriesReads, 2, 'An idle scan response must not hide a delayed import');
  assert.equal(scanBodies.length, 1);
  assert.equal(scanBodies[0].folderPath, reportedFolder);
  assert.equal(scanBodies[0].abortOnNoSeriesMatch, false);
  assert.deepEqual(searches, ['Sample title']);
  const home = await (await api.request('/home/matches')).json();
  assert.equal(home.items[0].seriesId, 1);
  assert.equal(home.items[0].candidate.providerSeriesId, 'candidate');
  assert.equal(getDb().select().from(schema.seriesMatches).all().length, 0);
  assert.equal(getDb().select().from(schema.syncHistory).all().length, 0);
  assert.ok(jobQueue.get(job.id)!.context?.series.some(item => item.id === 1));
});

test('Docker folder mappings identify the output and translate only its scan folder', async t => {
  remoteRoot = '/media/Doujins'; reportedFolder = '/media/Doujins/Sample title';
  setDownloaderSettings({ ...DEFAULT_DOWNLOADER, downloadDirectory: output, libraryPathMappings: [{ kavitaPath: remoteRoot, localPath: output }] });
  const result = await clock(t, () => runJob(queued(), () => {}));
  assert.equal(result.matchable, 1);
  assert.equal(scanBodies[0].folderPath, reportedFolder);
});

test('grouped ComicInfo series are verified by files rather than a shared title', async t => {
  reportedFolder = path.join(output, 'earlier-volume'); grouped = true;
  await clock(t, () => runJob(queued(), () => {}));
  assert.deepEqual(listMatchSuggestions().map(item => item.seriesId), [1]);
  assert.deepEqual(searches, ['Sample title']);
});

test('a targeted check preserves other suggestions and rejected candidates, including with automatic matching disabled', async t => {
  getDb().insert(schema.matchSuggestions).values({ connectionKey: 'https://kavita.test', seriesId: 99, name: 'Other unmatched title', libraryId: 1, libraryName: 'Downloads', candidatesJson: JSON.stringify([{ providerId: 'anilist', providerSeriesId: 'other', title: 'Other unmatched title', score: 1, type: 'MANGA' }]), checkedAt: new Date().toISOString() }).run();
  await clock(t, () => runJob(queued(), () => {}));
  assert.equal(rejectMatchCandidate(1, 'anilist', 'candidate'), true);
  t.mock.timers.reset();
  await clock(t, () => runJob(queued(), () => {}));
  assert.deepEqual(listMatchSuggestions().map(item => item.seriesId), [99]);
});

test('already matched series are skipped and no-match results never apply metadata', async t => {
  getDb().insert(schema.seriesMatches).values({ kavitaSeriesId: 1, status: 'matched' }).run();
  const result = await clock(t, () => runJob(queued(), () => {}));
  assert.equal(result.processed, 0);
  assert.deepEqual(searches, []);
  getDb().delete(schema.seriesMatches).run(); noMatch = true;
  t.mock.timers.reset();
  const empty = await clock(t, () => runJob(queued(), () => {}));
  assert.equal(empty.matchable, 0);
  assert.equal(getDb().select().from(schema.seriesMatches).all().length, 0);
});

test('provider errors do not change a completed download and prior suggestions remain available', async t => {
  getDb().insert(schema.downloadQueue).values({ source: 'hitomi', galleryId: 'completed', status: 'completed', outputPath: downloadPath }).run();
  await clock(t, () => runJob(queued(), () => {}));
  providerDown = true;
  t.mock.timers.reset();
  await assert.rejects(clock(t, () => runJob(queued(), () => {})), /Providers could not complete/);
  assert.equal(getDb().select().from(schema.downloadQueue).all()[0].status, 'completed');
  assert.equal(listMatchSuggestions().length, 1);
});

test('unmapped folders and a different Kavita connection stop before any unrelated scan or search', async t => {
  remoteRoot = path.join(dataDir, 'not-the-download-library');
  await assert.rejects(clock(t, () => runJob(queued(), () => {})), /shared mount/);
  assert.deepEqual(scanBodies, []); assert.deepEqual(searches, []);
  const job = queued(); job.payload.connectionKey = 'https://another-server.test';
  requests = [];
  await assert.rejects(runJob(job, () => {}), /connection changed/);
  assert.deepEqual(requests, []);
});

test('cancellation is observed during the Kavita import wait', async t => {
  const job = queued();
  getDb().update(schema.jobs).set({ status: 'running' }).where(eq(schema.jobs.id, job.id)).run();
  const fixtureFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (String(input).includes('/api/Server/is-task-running')) jobQueue.cancel(job.id);
    return fixtureFetch(input, init);
  };
  await assert.rejects(clock(t, () => runJob(job, () => {})), JobCancelled);
  assert.deepEqual(searches, []);
});

test('queued paths coalesce without losing a completion that arrives during a running check', () => {
  const first = queued();
  assert.equal(queued().id, first.id, JSON.stringify(jobQueue.active()));
  getDb().update(schema.jobs).set({ status: 'running' }).where(eq(schema.jobs.id, first.id)).run();
  const followUp = queued();
  assert.notEqual(followUp.id, first.id);
  assert.equal(queued().id, followUp.id);
  assert.throws(() => parseJobCommand('scan-downloaded', { path: 'relative.cbz', connectionKey: 'x' }), /absolute/);
  assert.throws(() => parseJobCommand('scan-downloaded', { path: downloadPath }), /connection/);
});

test('failed downloads and merge-owned staging downloads do not queue discovery before publication', async () => {
  const queue = new DownloadQueue(() => ({ ...DEFAULT_DOWNLOADER, downloadDirectory: output, requestDelayMs: 0 }));
  doujinProviders.hitomi = { ...originalHitomi, getGallery: async id => ({ source: 'hitomi', galleryId: id, title: 'Sample title', artists: [], tags: [], pages: [] }) };
  const failedId = queue.enqueue('hitomi', 'empty', 'Sample title', 'cbz');
  await new Promise<void>(resolve => {
    const unsubscribe = queue.subscribe(task => { if (task.id === failedId && task.status === 'failed') { unsubscribe(); resolve(); } });
  });
  assert.equal(jobQueue.active().length, 0);
  doujinProviders.hitomi = { ...originalHitomi, getGallery: async id => ({ source: 'hitomi', galleryId: id, title: 'Sample title', artists: [], tags: [], pages: ['https://images.test/1.jpg'] }) };
  const stagedId = queue.enqueue('hitomi', 'staged', 'Sample title', 'cbz', undefined, undefined, undefined, 123);
  await new Promise<void>(resolve => {
    const unsubscribe = queue.subscribe(task => { if (task.id === stagedId && task.status === 'completed') { unsubscribe(); resolve(); } });
  });
  await setImmediate();
  assert.equal(jobQueue.active().length, 0, 'The merge queues its final destination after moving the staged download');
});

test('unavailable scan status and an import that never appears fail visibly without treating them as no match', async t => {
  const fixtureFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (String(input).includes('/api/Server/is-task-running')) throw new Error('Status unavailable');
    return fixtureFetch(input, init);
  };
  await assert.rejects(clock(t, () => runJob(queued(), () => {})), /status could not be verified/);
  globalThis.fetch = fixtureFetch; indexDelay = Infinity;
  t.mock.timers.reset();
  await assert.rejects(clock(t, () => runJob(queued(), () => {})), /has not indexed/);
  assert.deepEqual(searches, []);
});

test('the registered background worker completes discovery and records its result for Home', async t => {
  const job = queued();
  await clock(t, async () => {
    jobQueue.registerHandler(runJob);
    while (['queued', 'running'].includes(jobQueue.get(job.id)!.status)) await setImmediate();
  });
  const finished = jobQueue.get(job.id)!;
  assert.equal(finished.status, 'completed', finished.errorMessage ?? '');
  assert.deepEqual(finished.result, { processed: 1, matchable: 1, failed: 0 });
  const home = await (await api.request('/home/matches')).json();
  assert.equal(home.scan.id, job.id);
  assert.equal(home.scan.status, 'completed');
  assert.equal(home.items[0].candidate.providerSeriesId, 'candidate');
});
