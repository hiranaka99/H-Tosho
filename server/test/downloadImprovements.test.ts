import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, test } from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'htosho-dl-improvements-'));
const outputDir = path.join(dataDir, 'output');
process.env.HTOSHO_DATA_DIR = dataDir;

const { initDb, getDb, getTmpDir, schema } = await import('../src/db/index.js');
const { DownloadQueue, downloadQueue: singletonQueue } = await import('../src/downloader/engine.js');
const { downloadPages } = await import('../src/downloader/transfer.js');
const { classifyDownloadError, errorRetryAfterMs, isRouteRefreshableError, isTransientError } = await import('../src/downloader/requests.js');
const { DownloadPausedError, DownloadShutdownError } = await import('../src/downloader/runtime.js');
const { EhentaiUpstreamError } = await import('../src/downloader/ehentaiClient.js');
const { RequestAbortedError } = await import('../src/downloader/ehentaiGate.js');
const { fetchToFileStreaming, HttpStatusError } = await import('../src/lib/http.js');
const { buildZip, buildZipFromFiles } = await import('../src/downloader/zip.js');
const { doujinProviders } = await import('../src/downloader/providers.js');
const { DEFAULT_DOWNLOADER, setDownloaderSettings } = await import('../src/services/settings.js');
const { invalidateDuplicateLibrary, lookupLibraryMatches, prepareDuplicateCheck, resolveDuplicateGallery } = await import('../src/services/galleryDuplicates.js');
const { api } = await import('../src/routes/api.js');
import type { DoujinGallery } from '../src/downloader/types.js';
import type { RunContext } from '../src/downloader/runtime.js';

initDb();
fs.mkdirSync(outputDir, { recursive: true });

const originalFetch = globalThis.fetch;
const originalProviders = { ...doujinProviders };

function makeSettings(overrides: Partial<typeof DEFAULT_DOWNLOADER> = {}) {
  return {
    ...DEFAULT_DOWNLOADER,
    downloadDirectory: outputDir,
    format: 'cbz' as const,
    maxConcurrentDownloads: 1,
    maxImageConcurrency: 1,
    requestDelayMs: 0,
    autoSyncKavita: false,
    ...overrides,
  };
}

function makeCtx(): RunContext {
  return {
    cancelled: false,
    paused: false,
    shuttingDown: false,
    stopped: false,
    committing: false,
    controller: new AbortController(),
    pauseSignal: { paused: false, waiters: [] },
  };
}

function waitForStatus(queue: InstanceType<typeof DownloadQueue>, id: number, status: string): Promise<void> {
  return new Promise((resolve) => {
    let unsubscribe = () => {};
    const finish = (): void => {
      unsubscribe();
      resolve();
    };
    unsubscribe = queue.subscribe((task) => {
      if (task.id === id && task.status === status) finish();
    });
    if (queue.get(id)?.status === status) finish();
  });
}

function waitForIdle(queue: InstanceType<typeof DownloadQueue>, id: number): Promise<void> {
  return new Promise((resolve) => {
    let unsubscribe = () => {};
    const finish = (): void => {
      unsubscribe();
      resolve();
    };
    unsubscribe = queue.subscribe((task) => {
      if (task.id === id && !queue.isRunning(id)) finish();
    });
    if (!queue.isRunning(id)) finish();
  });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  Object.assign(doujinProviders, originalProviders);
  getDb().delete(schema.downloadQueue).run();
  getDb().delete(schema.ownedGalleries).run();
  getDb().delete(schema.keyValueStore).run();
  invalidateDuplicateLibrary();
});

after(() => {
  globalThis.fetch = originalFetch;
  Object.assign(doujinProviders, originalProviders);
});

// ---------------- HTTP streaming integrity & Retry-After ----------------

test('fetchToFileStreaming rejects empty, truncated, and HTML responses and carries Retry-After on 429', async () => {
  const dir = fs.mkdtempSync(path.join(dataDir, 'stream-'));
  const dest = path.join(dir, 'page');

  // 1. 0-byte HTTP 200 body rejected; neither dest nor .part remains.
  globalThis.fetch = (async () => new Response(Buffer.alloc(0), { status: 200, headers: { 'content-type': 'image/jpeg' } })) as typeof fetch;
  await assert.rejects(fetchToFileStreaming('https://cdn.test/empty.jpg', {}, dest, {}, 5000, { rejectHtml: true }), /Empty response body/i);
  assert.equal(fs.existsSync(dest), false);
  assert.equal(fs.existsSync(`${dest}.part`), false);

  // 2. Truncated body (declared Content-Length > actual received bytes without Content-Encoding).
  globalThis.fetch = (async () => new Response(Buffer.from('short'), {
    status: 200,
    headers: { 'content-type': 'image/jpeg', 'content-length': '100' },
  })) as typeof fetch;
  await assert.rejects(fetchToFileStreaming('https://cdn.test/trunc.jpg', {}, dest, {}, 5000, { rejectHtml: true }), /Incomplete download: received 5 of 100/);
  assert.equal(fs.existsSync(dest), false);
  assert.equal(fs.existsSync(`${dest}.part`), false);

  // 3. Content-Encoding present: decoded length may differ from compressed Content-Length.
  globalThis.fetch = (async () => new Response(Buffer.from('decoded-image'), {
    status: 200,
    headers: { 'content-type': 'image/jpeg', 'content-length': '200', 'content-encoding': 'gzip' },
  })) as typeof fetch;
  const written = await fetchToFileStreaming('https://cdn.test/gzip.jpg', {}, dest, {}, 5000, { rejectHtml: true });
  assert.equal(written, 13);
  assert.equal(fs.readFileSync(dest, 'utf8'), 'decoded-image');
  fs.unlinkSync(dest);

  // 4. HTTP 200 text/html rejected when rejectHtml is true.
  globalThis.fetch = (async () => new Response('<html><body>Cloudflare challenge</body></html>', {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })) as typeof fetch;
  await assert.rejects(fetchToFileStreaming('https://cdn.test/cf.jpg', {}, dest, {}, 5000, { rejectHtml: true }), /unexpected HTML response/i);
  assert.equal(fs.existsSync(dest), false);

  // 5. HTTP 429 throws HttpStatusError carrying Retry-After.
  globalThis.fetch = (async () => new Response('slow down', {
    status: 429,
    headers: { 'retry-after': '7' },
  })) as typeof fetch;
  await assert.rejects(
    fetchToFileStreaming('https://cdn.test/rate.jpg', {}, dest, {}, 5000),
    (err: unknown) => {
      assert.ok(err instanceof HttpStatusError);
      assert.equal(err.status, 429);
      assert.equal(err.retryAfterMs, 7000);
      assert.equal(errorRetryAfterMs(err), 7000);
      return true;
    },
  );
});

// ---------------- Error classification & transience ----------------

test('error classification and transience separate quota, disk-full, pause, shutdown, and transient blips', () => {
  assert.equal(isTransientError(new DownloadPausedError()), false);
  assert.equal(isTransientError(new DownloadShutdownError()), false);
  assert.equal(isTransientError(new RequestAbortedError()), false);
  assert.equal(isTransientError(new Error('Cancelled by user')), false);
  assert.equal(isTransientError(new EhentaiUpstreamError('quota', 'quota', 509)), false);
  assert.equal(isTransientError(new EhentaiUpstreamError('denied', 'denied', 403)), false);
  assert.equal(isTransientError(new EhentaiUpstreamError('blocked', 'blocked')), false);

  assert.equal(isTransientError(new EhentaiUpstreamError('rate', 'rate-limited', 429, 3000)), true);
  assert.equal(isTransientError(new HttpStatusError('Download failed: HTTP 503', 503)), true);
  assert.equal(isTransientError(new Error('Incomplete download: received 10 of 20 bytes')), true);
  assert.equal(isTransientError(new Error('Empty response body (0 bytes)')), true);
  assert.equal(isTransientError(new Error('Request timed out')), true);
  assert.equal(isTransientError(new Error('connect ECONNREFUSED 1.2.3.4')), true);

  assert.equal(isRouteRefreshableError(new HttpStatusError('Download failed: HTTP 404', 404)), true);
  assert.equal(isRouteRefreshableError(new HttpStatusError('Download failed: HTTP 410', 410)), true);
  assert.equal(isRouteRefreshableError(new Error('Download failed: unexpected HTML response (text/html)')), true);
  assert.equal(isRouteRefreshableError(new HttpStatusError('Download failed: HTTP 403', 403)), false);
  assert.equal(isRouteRefreshableError(new EhentaiUpstreamError('quota', 'quota', 509)), false);

  assert.equal(classifyDownloadError(new EhentaiUpstreamError('quota', 'quota', 509)), 'quota');
  assert.equal(classifyDownloadError(new Error('HTTP 509 quota exhausted')), 'quota');
  assert.equal(classifyDownloadError(new Error('ENOSPC: no space left on device')), 'disk-full');
  assert.equal(classifyDownloadError(new Error('EDQUOT: disk quota exceeded')), 'disk-full');
  assert.equal(classifyDownloadError(new EhentaiUpstreamError('denied', 'denied', 403)), 'access-denied');
  assert.equal(classifyDownloadError(new EhentaiUpstreamError('rate', 'rate-limited', 429)), 'rate-limit');
  assert.equal(classifyDownloadError(new Error('anything'), true), 'cancelled');
});

// ---------------- Transfer smart refresh, multi-server failover, immediate resume progress ----------------

test('transfer refreshes immediately on HTTP 404, skips refresh on 403, fails over across 3+ servers, and emits resumed progress immediately', async () => {
  const tmpDir = fs.mkdtempSync(path.join(dataDir, 'transfer-smart-'));
  let forceCalls = 0;
  const gallery404: DoujinGallery = {
    source: 'hitomi',
    galleryId: 'rot',
    title: 'Rotated CDN',
    tags: [],
    artists: [],
    pages: ['https://old.cdn.test/0.jpg'],
    async resolvePageUrl(_index, opts) {
      if (opts?.forceRefresh) {
        forceCalls++;
        return { url: 'https://fresh.cdn.test/0.jpg' };
      }
      return { url: 'https://old.cdn.test/0.jpg' };
    },
  };
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('old.cdn.test')) return new Response('gone', { status: 404 });
    return new Response(Buffer.from('fresh-image'), { status: 200, headers: { 'content-type': 'image/jpeg' } });
  }) as typeof fetch;

  const t0 = Date.now();
  const out = await downloadPages(gallery404, 1, makeSettings(), makeCtx(), tmpDir, () => {});
  assert.equal(forceCalls, 1);
  assert.equal(out.length, 1);
  assert.ok(Date.now() - t0 < 2000, 'HTTP 404 route refresh must not sleep 30 seconds');

  // HTTP 403 should fail immediately without calling forceRefresh: true.
  let forbiddenRefreshCalls = 0;
  const gallery403: DoujinGallery = {
    source: 'hitomi',
    galleryId: 'denied',
    title: 'Denied',
    tags: [],
    artists: [],
    pages: ['https://cdn.test/403.jpg'],
    async resolvePageUrl(_index, opts) {
      if (opts?.forceRefresh) forbiddenRefreshCalls++;
      return { url: 'https://cdn.test/403.jpg' };
    },
  };
  globalThis.fetch = (async () => new Response('forbidden', { status: 403 })) as typeof fetch;
  await assert.rejects(
    downloadPages(gallery403, 2, makeSettings(), makeCtx(), fs.mkdtempSync(path.join(dataDir, 'transfer-403-')), () => {}),
    /403/,
  );
  assert.equal(forbiddenRefreshCalls, 0);

  // Multi-server fallbacks (i1 -> i2 -> i3): succeeds on the 3rd mirror.
  const tried: string[] = [];
  const galleryMirrors: DoujinGallery = {
    source: 'nhentai',
    galleryId: 'mirrors',
    title: 'Mirrors',
    tags: [],
    artists: [],
    pages: ['https://i1.nhentai.net/galleries/1/1.jpg'],
    async resolvePageUrl() {
      return {
        url: 'https://i1.nhentai.net/galleries/1/1.jpg',
        fallback: 'https://i2.nhentai.net/galleries/1/1.jpg',
        fallbacks: ['https://i2.nhentai.net/galleries/1/1.jpg', 'https://i3.nhentai.net/galleries/1/1.jpg'],
      };
    },
  };
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    tried.push(url);
    if (url.includes('i3.nhentai.net')) return new Response(Buffer.from('mirror-3-ok'), { status: 200, headers: { 'content-type': 'image/jpeg' } });
    return new Response('missing', { status: 404 });
  }) as typeof fetch;
  const mirrorOut = await downloadPages(galleryMirrors, 3, makeSettings(), makeCtx(), fs.mkdtempSync(path.join(dataDir, 'transfer-mirrors-')), () => {});
  assert.equal(mirrorOut.length, 1);
  assert.deepEqual(tried, [
    'https://i1.nhentai.net/galleries/1/1.jpg',
    'https://i2.nhentai.net/galleries/1/1.jpg',
    'https://i3.nhentai.net/galleries/1/1.jpg',
  ]);

  // Immediate resume progress emission before the next page finishes fetching.
  const resumeDir = fs.mkdtempSync(path.join(dataDir, 'transfer-resume-'));
  fs.writeFileSync(path.join(resumeDir, '0'), Buffer.alloc(120, 1));
  fs.writeFileSync(path.join(resumeDir, '1'), Buffer.alloc(130, 2));
  const releasePage2 = Promise.withResolvers<void>();
  const startedPage2 = Promise.withResolvers<void>();
  const progressEvents: Array<{ current: number; total: number; bytes: number }> = [];
  globalThis.fetch = (async () => {
    startedPage2.resolve();
    await releasePage2.promise;
    return new Response(Buffer.alloc(100, 3), { status: 200, headers: { 'content-type': 'image/jpeg' } });
  }) as typeof fetch;
  const resumeGallery: DoujinGallery = {
    source: 'hitomi',
    galleryId: 'res-imm',
    title: 'Resume Imm',
    tags: [],
    artists: [],
    pages: ['https://cdn.test/0.jpg', 'https://cdn.test/1.jpg', 'https://cdn.test/2.jpg'],
  };
  const promise = downloadPages(resumeGallery, 4, makeSettings(), makeCtx(), resumeDir, (_id, patch) => {
    progressEvents.push({ current: patch.progressCurrent ?? -1, total: patch.progressTotal ?? -1, bytes: patch.bytesCurrent ?? -1 });
  });
  await startedPage2.promise;
  assert.ok(progressEvents.length >= 1, 'resumed progress must be emitted before page 2 finishes');
  assert.equal(progressEvents[0].current, 2);
  assert.equal(progressEvents[0].total, 3);
  assert.equal(progressEvents[0].bytes, 250);
  releasePage2.resolve();
  await promise;
});

// ---------------- Queue pause frees concurrency slot & preserves partials ----------------

test('pausing an active download frees its concurrency slot for queued work and preserves partial pages for resume', async () => {
  const fetchCounts = new Map<string, number>();
  const page1Reached = Promise.withResolvers<void>();
  let blockPage1 = true;

  doujinProviders.hitomi = {
    ...originalProviders.hitomi,
    async getGallery(idOrUrl) {
      return {
        source: 'hitomi',
        galleryId: idOrUrl,
        title: `Gallery ${idOrUrl}`,
        tags: [],
        artists: [],
        pages: [`https://cdn.test/${idOrUrl}/0.jpg`, `https://cdn.test/${idOrUrl}/1.jpg`],
      };
    },
  };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    fetchCounts.set(url, (fetchCounts.get(url) ?? 0) + 1);
    if (url === 'https://cdn.test/slot-a/1.jpg' && blockPage1) {
      page1Reached.resolve();
      await new Promise<void>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason ?? new Error('aborted')), { once: true });
      });
    }
    return new Response(Buffer.from(`img-${url}`), { status: 200, headers: { 'content-type': 'image/jpeg' } });
  }) as typeof fetch;

  const queue = new DownloadQueue(() => makeSettings({ maxConcurrentDownloads: 1, maxImageConcurrency: 1 }));
  const idA = queue.enqueue('hitomi', 'slot-a', 'Slot A', 'cbz');
  const idB = queue.enqueue('hitomi', 'slot-b', 'Slot B', 'cbz');

  await page1Reached.promise;
  assert.equal(queue.pause(idA), true);
  await waitForIdle(queue, idA);

  const pausedA = queue.get(idA)!;
  assert.equal(pausedA.status, 'paused');
  assert.equal(pausedA.speed, 0);
  assert.equal(pausedA.phase, null);
  assert.equal(pausedA.currentFile, null);
  assert.ok(fs.existsSync(path.join(getTmpDir(), 'downloads', String(idA), '0')), 'page 0 must survive pause');

  // Because pausing A freed the single concurrency slot, B must complete while A stays paused!
  await waitForStatus(queue, idB, 'completed');
  assert.equal(queue.get(idB)!.status, 'completed');
  assert.equal(queue.get(idA)!.status, 'paused');

  // Resume A: page 0 is NOT re-fetched, only page 1 is fetched, and A completes.
  blockPage1 = false;
  assert.equal(queue.resume(idA), true);
  await waitForStatus(queue, idA, 'completed');
  assert.equal(fetchCounts.get('https://cdn.test/slot-a/0.jpg'), 1, 'saved page 0 must not be re-fetched on resume');
  assert.equal(fetchCounts.get('https://cdn.test/slot-a/1.jpg'), 2);
});

// ---------------- Retry revision bump & broadcast when slots are full ----------------

test('retry bumps revision and broadcasts queued state immediately even when all download slots are occupied', async () => {
  const slotBlocked = Promise.withResolvers<void>();
  const releaseSlot = Promise.withResolvers<void>();

  doujinProviders.hitomi = {
    ...originalProviders.hitomi,
    async getGallery(idOrUrl) {
      if (idOrUrl === 'holder') {
        slotBlocked.resolve();
        await releaseSlot.promise;
      }
      return { source: 'hitomi', galleryId: idOrUrl, title: idOrUrl, tags: [], artists: [], pages: [`https://cdn.test/${idOrUrl}/0.jpg`] };
    },
  };
  globalThis.fetch = (async () => new Response(Buffer.from('image-bytes'), { status: 200 })) as typeof fetch;

  const queue = new DownloadQueue(() => makeSettings({ maxConcurrentDownloads: 1 }));
  const failedId = Number(getDb().insert(schema.downloadQueue).values({
    source: 'hitomi',
    galleryId: 'retry-full',
    status: 'failed',
    outputFormat: 'cbz',
    errorMessage: 'HTTP 403',
    errorCode: 'access-denied',
    phase: 'downloading',
    revision: 5,
  }).run().lastInsertRowid);

  const holderId = queue.enqueue('hitomi', 'holder', 'Holder', 'cbz');
  await slotBlocked.promise;

  const broadcasted: Array<{ status: string; revision: number; phase: string | null }> = [];
  const unsub = queue.subscribe((task) => {
    if (task.id === failedId) broadcasted.push({ status: task.status, revision: task.revision, phase: task.phase });
  });
  try {
    assert.equal(queue.retry(failedId), true);
    assert.ok(broadcasted.length >= 1, 'retry must broadcast immediately even when slots are full');
    assert.equal(broadcasted[0].status, 'queued');
    assert.equal(broadcasted[0].phase, null);
    assert.ok(broadcasted[0].revision > 5, 'revision must increase so mergeDownloadPoll keeps the new state');

    releaseSlot.resolve();
    await Promise.all([waitForStatus(queue, holderId, 'completed'), waitForStatus(queue, failedId, 'completed')]);
  } finally {
    releaseSlot.resolve();
    unsub();
  }
});

// ---------------- Bulk controls, prioritize, onSettingsChanged, shutdown, orphan cleanup ----------------

test('prioritize, pauseAll, resumeAll, retryFailed, clearCancelled, onSettingsChanged, shutdown, and orphan cleanup work cleanly', async () => {
  const claimedOrder: string[] = [];
  const gates = new Map<string, PromiseWithResolvers<void>>();
  const reached = new Map<string, PromiseWithResolvers<void>>();

  doujinProviders.hitomi = {
    ...originalProviders.hitomi,
    async getGallery(idOrUrl) {
      claimedOrder.push(idOrUrl);
      reached.get(idOrUrl)?.resolve();
      const gate = gates.get(idOrUrl);
      if (gate) await gate.promise;
      return { source: 'hitomi', galleryId: idOrUrl, title: idOrUrl, tags: [], artists: [], pages: [`https://cdn.test/${idOrUrl}/0.jpg`] };
    },
  };
  globalThis.fetch = (async () => new Response(Buffer.from('ok-image'), { status: 200 })) as typeof fetch;

  let maxConcurrent = 1;
  const queue = new DownloadQueue(() => makeSettings({ maxConcurrentDownloads: maxConcurrent }));

  // 1. Startup orphan cleanup removes stale scratch + staging dirs while keeping active task scratch dir.
  const orphanScratch = path.join(getTmpDir(), 'downloads', '999999');
  const orphanStaging = path.join(outputDir, '.htosho-download-orphan');
  fs.mkdirSync(orphanScratch, { recursive: true });
  fs.writeFileSync(path.join(orphanScratch, '0'), 'stale');
  fs.mkdirSync(orphanStaging, { recursive: true });
  fs.writeFileSync(path.join(orphanStaging, '001.jpg'), 'stale');

  const keepPausedId = Number(getDb().insert(schema.downloadQueue).values({
    source: 'hitomi', galleryId: 'keep-paused', status: 'paused', outputFormat: 'cbz',
  }).run().lastInsertRowid);
  const keepScratch = path.join(getTmpDir(), 'downloads', String(keepPausedId));
  fs.mkdirSync(keepScratch, { recursive: true });
  fs.writeFileSync(path.join(keepScratch, '0'), 'keep');

  queue.start();
  for (let i = 0; i < 50 && (fs.existsSync(orphanScratch) || fs.existsSync(orphanStaging)); i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(fs.existsSync(orphanScratch), false, 'orphaned tmp/downloads/<id> must be removed on startup');
  assert.equal(fs.existsSync(orphanStaging), false, 'orphaned .htosho-download-* dir must be removed on startup');
  assert.equal(fs.existsSync(keepScratch), true, 'paused task scratch dir must be preserved');
  queue.cancel(keepPausedId);
  queue.remove(keepPausedId);

  // 2. Prioritize moves a queued item ahead of earlier queued items.
  gates.set('first', Promise.withResolvers<void>());
  reached.set('first', Promise.withResolvers<void>());
  const firstId = queue.enqueue('hitomi', 'first', 'First', 'cbz');
  await reached.get('first')!.promise;
  const secondId = queue.enqueue('hitomi', 'second', 'Second', 'cbz');
  const thirdId = queue.enqueue('hitomi', 'third', 'Third', 'cbz');
  assert.equal(queue.prioritize(thirdId), true);
  assert.equal(queue.prioritize(firstId), false, 'cannot prioritize an already downloading task');

  // 3. onSettingsChanged wakes queued work immediately when concurrency increases.
  gates.set('third', Promise.withResolvers<void>());
  reached.set('third', Promise.withResolvers<void>());
  maxConcurrent = 2;
  queue.onSettingsChanged();
  await reached.get('third')!.promise;
  assert.deepEqual(claimedOrder.slice(0, 2), ['first', 'third'], 'prioritized task must claim next when slot opens');

  // 4. pauseAll pauses queued tasks before active tasks so `second` is never claimed mid-sweep.
  assert.equal(queue.pauseAll(), 3);
  gates.get('first')!.resolve();
  gates.get('third')!.resolve();
  await Promise.all([waitForIdle(queue, firstId), waitForIdle(queue, thirdId)]);
  assert.equal(queue.get(firstId)!.status, 'paused');
  assert.equal(queue.get(secondId)!.status, 'paused');
  assert.equal(queue.get(thirdId)!.status, 'paused');
  assert.equal(claimedOrder.includes('second'), false, 'pauseAll must pause queued tasks first so slots do not refill');

  // 5. resumeAll resumes every paused task.
  gates.clear();
  reached.clear();
  assert.equal(queue.resumeAll(), 3);
  await Promise.all([
    waitForStatus(queue, firstId, 'completed'),
    waitForStatus(queue, secondId, 'completed'),
    waitForStatus(queue, thirdId, 'completed'),
  ]);

  // 6. retryFailed retries permanent failures, skips cancelled & retry-wait; clearCancelled removes only cancelled.
  const failedPermanent = Number(getDb().insert(schema.downloadQueue).values({
    source: 'hitomi', galleryId: 'perm-fail', status: 'failed', outputFormat: 'cbz', errorCode: 'access-denied', errorMessage: '403',
  }).run().lastInsertRowid);
  const cancelledRow = Number(getDb().insert(schema.downloadQueue).values({
    source: 'hitomi', galleryId: 'cancelled-row', status: 'failed', outputFormat: 'cbz', errorCode: 'cancelled', errorMessage: 'Cancelled by user',
  }).run().lastInsertRowid);
  const retryWaitRow = Number(getDb().insert(schema.downloadQueue).values({
    source: 'hitomi', galleryId: 'retry-wait-row', status: 'failed', outputFormat: 'cbz', errorCode: 'network', retryAt: new Date(Date.now() + 60_000).toISOString(), retryCount: 1,
  }).run().lastInsertRowid);
  const cancelledScratch = path.join(getTmpDir(), 'downloads', String(cancelledRow));
  fs.mkdirSync(cancelledScratch, { recursive: true });
  fs.writeFileSync(path.join(cancelledScratch, '0'), 'partial');

  assert.equal(queue.retryFailed(), 1);
  await waitForStatus(queue, failedPermanent, 'completed');
  assert.equal(queue.get(cancelledRow)!.state.type, 'cancelled');
  assert.equal(queue.get(retryWaitRow)!.state.type, 'retry-wait');

  assert.equal(queue.clearCancelled(), 1);
  assert.equal(queue.get(cancelledRow), null);
  assert.ok(queue.get(failedPermanent), 'completed row must remain after clearCancelled');
  assert.ok(queue.get(retryWaitRow), 'retry-wait row must remain after clearCancelled');
  for (let i = 0; i < 50 && fs.existsSync(cancelledScratch); i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(fs.existsSync(cancelledScratch), false, 'clearCancelled must remove scratch dirs');

  // 7. shutdown aborts active work cleanly and leaves it queued for next startup.
  const shutStarted = Promise.withResolvers<void>();
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    shutStarted.resolve();
    await new Promise<void>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason ?? new Error('aborted')), { once: true });
    });
    return new Response(Buffer.from('never'));
  }) as typeof fetch;
  const shutId = queue.enqueue('hitomi', 'shut-task', 'Shut Task', 'cbz');
  await shutStarted.promise;
  await queue.shutdown(1000);
  assert.equal(queue.get(shutId)!.status, 'queued');
  assert.equal(queue.isRunning(shutId), false);
});

// ---------------- New API routes & cover natural ordering + nosniff ----------------

test('new download API endpoints and cover natural sorting + nosniff work properly', async () => {
  setDownloaderSettings(makeSettings());

  // Seed paused + cancelled + failed tasks and exercise bulk API endpoints.
  const cancelledId = Number(getDb().insert(schema.downloadQueue).values({
    source: 'hitomi', galleryId: 'api-cancel', status: 'failed', outputFormat: 'cbz', errorCode: 'cancelled', errorMessage: 'Cancelled by user',
  }).run().lastInsertRowid);
  const pausedId = Number(getDb().insert(schema.downloadQueue).values({
    source: 'hitomi', galleryId: 'api-paused', status: 'paused', outputFormat: 'cbz',
  }).run().lastInsertRowid);

  // pause-all returns count 0 when nothing queued/downloading; clear-cancelled removes 1.
  const pauseRes = await api.request('/downloads/pause-all', { method: 'POST' });
  assert.equal(pauseRes.status, 200);
  assert.deepEqual(await pauseRes.json(), { ok: true, count: 0 });

  const clearRes = await api.request('/downloads/clear-cancelled', { method: 'POST' });
  assert.equal(clearRes.status, 200);
  assert.deepEqual(await clearRes.json(), { ok: true, removed: 1 });
  assert.equal(singletonQueue.get(cancelledId), null);

  // prioritize returns 400 on non-queued task.
  const badPrio = await api.request(`/downloads/${pausedId}/prioritize`, { method: 'POST' });
  assert.equal(badPrio.status, 400);

  // retry-failed returns count 0 when no permanent failures exist.
  const retryRes = await api.request('/downloads/retry-failed', { method: 'POST' });
  assert.equal(retryRes.status, 200);
  assert.deepEqual(await retryRes.json(), { ok: true, count: 0 });

  // Cover endpoint: natural order (page 2 before page 10) for BOTH CBZ and folder downloads, with X-Content-Type-Options: nosniff.
  const cbzPath = path.join(outputDir, 'natural-order.cbz');
  fs.writeFileSync(cbzPath, buildZip([
    { name: '10.jpg', data: Buffer.from('page-ten') },
    { name: '2.jpg', data: Buffer.from('page-two') },
  ]));
  const cbzTaskId = Number(getDb().insert(schema.downloadQueue).values({
    source: 'hitomi', galleryId: 'cover-cbz', status: 'completed', outputFormat: 'cbz', outputPath: cbzPath,
  }).run().lastInsertRowid);
  const cbzCover = await api.request(`/downloads/${cbzTaskId}/cover`);
  assert.equal(cbzCover.status, 200);
  assert.equal(cbzCover.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(Buffer.from(await cbzCover.arrayBuffer()).toString('utf8'), 'page-two');

  const folderPath = path.join(outputDir, 'natural-folder');
  fs.mkdirSync(folderPath, { recursive: true });
  fs.writeFileSync(path.join(folderPath, '10.png'), Buffer.from('folder-ten'));
  fs.writeFileSync(path.join(folderPath, '2.png'), Buffer.from('folder-two'));
  const folderTaskId = Number(getDb().insert(schema.downloadQueue).values({
    source: 'hitomi', galleryId: 'cover-folder', status: 'completed', outputFormat: 'folder', outputPath: folderPath,
  }).run().lastInsertRowid);
  const folderCover = await api.request(`/downloads/${folderTaskId}/cover`);
  assert.equal(folderCover.status, 200);
  assert.equal(folderCover.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(folderCover.headers.get('content-type'), 'image/png');
  assert.equal(Buffer.from(await folderCover.arrayBuffer()).toString('utf8'), 'folder-two');
});

// ---------------- Duplicate preflight cache canonicalization & E-Hentai provenance ----------------

test('duplicate preflight shares cache between galleryId and canonical URL and detects E-Hentai provenance', async () => {
  setDownloaderSettings(makeSettings());
  let calls = 0;
  doujinProviders.hitomi = {
    ...originalProviders.hitomi,
    async getGallery(idOrUrl) {
      calls++;
      return {
        source: 'hitomi',
        galleryId: '4242',
        title: `Cached ${idOrUrl}`,
        artists: ['Artist A'],
        language: 'English',
        tags: [],
        pages: ['https://cdn.test/1.jpg'],
      };
    },
  };
  await prepareDuplicateCheck([{ source: 'hitomi', galleryId: '4242', url: 'https://hitomi.la/reader/4242.html' }]);
  await resolveDuplicateGallery('hitomi', 'https://hitomi.la/doujinshi/cached-4242.html', true);
  assert.equal(calls, 1, 'preflight and worker lookup must share one canonical cache key');

  // E-Hentai provenance via <Web> and via [ehentai-<gid>-<token>] filename.
  const ehDir = fs.mkdtempSync(path.join(dataDir, 'eh-prov-'));
  setDownloaderSettings(makeSettings({ downloadDirectory: ehDir }));
  fs.writeFileSync(path.join(ehDir, 'WebTagged.cbz'), buildZip([
    { name: 'ComicInfo.xml', data: Buffer.from('<ComicInfo><Title>Renamed</Title><Web>https://exhentai.org/g/123456/abcdef0123/</Web></ComicInfo>') },
    { name: '001.jpg', data: Buffer.from('img') },
  ]));
  fs.writeFileSync(path.join(ehDir, 'Sample [ehentai-987654-1234567890].cbz'), buildZip([
    { name: 'ComicInfo.xml', data: Buffer.from('<ComicInfo><Title>Renamed</Title></ComicInfo>') },
    { name: '001.jpg', data: Buffer.from('img') },
  ]));
  invalidateDuplicateLibrary();

  const matches = await lookupLibraryMatches([
    { source: 'ehentai', galleryId: '123456-abcdef0123', title: 'Other', artists: [] },
    { source: 'ehentai', galleryId: '987654-1234567890', title: 'Other', artists: [] },
    { source: 'ehentai', galleryId: '111111-0000000000', title: 'Unrelated', artists: [] },
  ]);
  assert.equal(matches.reports[0].matches[0]?.confirmed, true);
  assert.equal(matches.reports[1].matches[0]?.confirmed, true);
  assert.equal(matches.reports[2].matches.length, 0);
});

// ---------------- ZIP abort support ----------------

test('buildZipFromFiles aborts cleanly when signal is aborted', async () => {
  const dir = fs.mkdtempSync(path.join(dataDir, 'zip-abort-'));
  const img = path.join(dir, '001.jpg');
  const dest = path.join(dir, 'out.cbz');
  fs.writeFileSync(img, Buffer.from('image-data'));

  const controller = new AbortController();
  controller.abort(new Error('Cancelled by user'));
  await assert.rejects(
    buildZipFromFiles([{ name: '001.jpg', path: img }], dest, [], controller.signal),
    /Cancelled by user/,
  );
  assert.equal(fs.existsSync(dest), false);
});
