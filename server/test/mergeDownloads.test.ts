import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { afterEach, test, type TestContext } from 'node:test';
import { eq } from 'drizzle-orm';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'htosho-merge-downloads-'));
process.env.HTOSHO_DATA_DIR = dataDir;
const { initDb, getDb, schema } = await import('../src/db/index.js');
const { runJob } = await import('../src/jobs/executor.js');
const { jobQueue, JobCancelled } = await import('../src/jobs/queue.js');
const { prepareMergeDownloads } = await import('../src/jobs/mergeDownloads.js');
const { downloadQueue } = await import('../src/downloader/engine.js');
const { doujinProviders } = await import('../src/downloader/providers.js');
const { galleryFilesystemName } = await import('../src/downloader/util.js');
const { buildZip } = await import('../src/downloader/zip.js');
const { readComicInfo } = await import('../src/lib/cbz.js');
const { parseComicInfo } = await import('../src/downloader/comicinfo.js');
const { setKavitaConnection, setDownloaderSettings, DEFAULT_DOWNLOADER } = await import('../src/services/settings.js');
const { api } = await import('../src/routes/api.js');
initDb();
setKavitaConnection({ baseUrl: 'https://kavita.example', apiKey: 'test' });
const originalFetch = globalThis.fetch;
const originalProvider = doujinProviders.hitomi;
afterEach(() => { globalThis.fetch = originalFetch; doujinProviders.hitomi = originalProvider; });

async function clock<T>(t: TestContext, run: () => Promise<T>): Promise<T> {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  let done = false;
  const result = run().finally(() => { done = true; });
  void result.catch(() => {});
  for (let step = 0; step < 1000; step++) {
    for (let flush = 0; flush < 20; flush++) await setImmediate();
    if (done) return result;
    t.mock.timers.tick(5_000);
  }
  assert.fail('Merge did not finish');
}

function archive(file: string, number = '12', series = 'Target Stamp'): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buildZip([{ name: '001.jpg', data: Buffer.from('image') }, { name: 'ComicInfo.xml', data: Buffer.from(`<ComicInfo><Series>${series}</Series><Number>${number}</Number><Writer>Keep Author</Writer></ComicInfo>`) }]));
}
async function fields(file: string) { return parseComicInfo((await readComicInfo(file))!).fields; }

function fixture(name: string) {
  const target = path.join(dataDir, name, 'Target');
  const existing = path.join(target, 'Existing.cbz');
  archive(existing);
  setDownloaderSettings({ ...DEFAULT_DOWNLOADER, downloadDirectory: path.join(dataDir, name, 'Downloads'), format: 'folder', maxConcurrentDownloads: 2, maxImageConcurrency: 1, requestDelayMs: 0, autoSyncKavita: true });
  const counts = new Map<string, number>();
  const requests: string[] = [];
  const scans: string[][] = [];
  let failId = '';
  let waitForId = '';
  doujinProviders.hitomi = {
    ...originalProvider,
    async getGallery(id) {
      counts.set(id, (counts.get(id) ?? 0) + 1);
      // No move or existing metadata write can precede the downloads.
      assert.equal((await fields(existing)).Number, '12');
      return { source: 'hitomi', galleryId: id, title: `Gallery ${id}`, tags: [], artists: [], pages: [`https://images.example/${id}.jpg`] };
    },
  };
  globalThis.fetch = (async input => {
    const url = String(input);
    requests.push(url);
    if (url.startsWith('https://images.example/')) {
      if (url.includes(`/${failId}.jpg`)) {
        // Make one gallery genuinely complete before its sibling fails, so
        // retry coverage distinguishes completed media from resumable pages.
        for (let step = 0; waitForId && !downloadQueue.findCompleted('hitomi', waitForId) && step < 1000; step++) await setImmediate();
        return new Response('missing', { status: 404 });
      }
      return new Response(Buffer.from('image bytes'));
    }
    if (url.endsWith('/api/Series/50')) return Response.json({ id: 50, libraryId: 7, name: 'Target', folderPath: target });
    if (url.includes('/api/Library/libraries')) return Response.json([{ id: 7, name: 'Collection', folders: [dataDir], type: 0 }]);
    if (url.includes('/api/Series/all-v2')) return Response.json([{ id: 50, libraryId: 7, name: 'Target', folderPath: target }]);
    if (url.includes('/api/Server/is-task-running')) return Response.json(false);
    if (url.endsWith('/api/Series/scan') || url.includes('/api/Library/scan')) { scans.push(fs.readdirSync(target)); return Response.json({ ok: true }); }
    if (url.includes('/api/Search/chapters-by-series')) return Response.json(fs.readdirSync(target).filter(file => file.endsWith('.cbz')).map((file, i) => ({ id: i + 1, files: [{ id: i + 1, filePath: path.join(target, file) }] })));
    return Response.json({ ok: true });
  }) as typeof fetch;
  return { target, existing, counts, requests, scans, fail: (id: string, after = '') => { failId = id; waitForId = after; } };
}
function runningJob(payload: Parameters<typeof jobQueue.enqueue>[1]) {
  const id = jobQueue.enqueue('merge-series', payload);
  getDb().update(schema.jobs).set({ status: 'running' }).where(eq(schema.jobs.id, id)).run();
  return jobQueue.get(id)!;
}
const plan = (id: string, chapter = '13') => ({ source: 'hitomi' as const, galleryId: id, title: `Gallery ${id}`, chapter });

test('final merge downloads missing galleries as CBZ, reuses existing files, and scans only the final series', async t => {
  const f = fixture('success');
  const ready = path.join(dataDir, 'ready', 'Ready.cbz');
  archive(ready, '3', 'Old Series');
  const readyTask = getDb().insert(schema.downloadQueue).values({ source: 'hitomi', galleryId: 'ready', status: 'completed', outputFormat: 'cbz', outputPath: ready }).run();
  const collision = path.join(f.target, `ch14.5 ${galleryFilesystemName('Gallery fresh-a', 'hitomi', 'fresh-a')}.cbz`);
  archive(collision, '20');
  const job = runningJob({ seriesId: 50, sourceFiles: [ready], chapters: { [ready]: '13' }, existingChapters: { [f.existing]: '11.5' }, downloads: [plan('fresh-a', '14.5'), plan('fresh-b', '')] });
  assert.equal(f.counts.size, 0, 'Saving the plan starts no downloads without job execution');
  const result = await clock(t, () => runJob(job, () => {}));
  assert.deepEqual(result, { processed: 3, matched: 0, failed: 0 });
  assert.equal(f.counts.get('fresh-a'), 1);
  assert.equal(f.counts.get('fresh-b'), 1);
  assert.equal((await fields(f.existing)).Number, '11.5');
  assert.equal((await fields(f.existing)).Writer, 'Keep Author');
  for (const id of ['fresh-a', 'fresh-b']) {
    const task = downloadQueue.findCompleted('hitomi', id)!;
    assert.equal(task.outputFormat, 'cbz', 'Folder output setting does not prevent merge downloads');
    assert.equal(path.dirname(task.outputPath!), f.target);
    assert.equal((await fields(task.outputPath!)).Series, 'Target Stamp');
    assert.equal(jobQueue.get(job.id)!.payload.mergeDownloadIds?.[`hitomi:${id}`], task.id);
  }
  const a = downloadQueue.findCompleted('hitomi', 'fresh-a')!;
  assert.ok(a.outputPath!.endsWith(' (2).cbz'), 'Name collision is preserved and download history follows the destination');
  assert.equal((await fields(a.outputPath!)).Number, '14.5');
  assert.equal((await fields(downloadQueue.get(Number(readyTask.lastInsertRowid))!.outputPath!)).Number, '13');
  assert.equal(f.scans.length, 1, 'Per-download scans are deferred until the entire merge is published');
  assert.equal(f.scans[0].filter(file => file.endsWith('.cbz')).length, 5);
});

test('download failure preserves existing chapters; job retry reuses successful and failed download task IDs', async t => {
  const f = fixture('retry');
  f.fail('retry-b', 'retry-a');
  const job = runningJob({ seriesId: 50, existingChapters: { [f.existing]: '9' }, downloads: [plan('retry-a'), plan('retry-b', '14')] });
  await assert.rejects(clock(t, () => runJob(job, () => {})), /Download failed.*retry-b/);
  assert.equal((await fields(f.existing)).Number, '12');
  assert.deepEqual(fs.readdirSync(f.target), ['Existing.cbz']);
  assert.equal(f.scans.length, 0);
  assert.ok(downloadQueue.findCompleted('hitomi', 'retry-a'), 'First gallery is complete before the failure');
  const checkpoints = jobQueue.get(job.id)!.payload.mergeDownloadIds!;
  assert.equal(Object.keys(checkpoints).length, 2);
  // The real queue marks a handler rejection failed before presenting Retry.
  getDb().update(schema.jobs).set({ status: 'failed' }).where(eq(schema.jobs.id, job.id)).run();
  const retryId = jobQueue.retryJob(job.id)!;
  getDb().update(schema.jobs).set({ status: 'running' }).where(eq(schema.jobs.id, retryId)).run();
  f.fail('');
  t.mock.timers.reset();
  const retried = await clock(t, () => runJob(jobQueue.get(retryId)!, () => {}));
  assert.equal(retried.processed, 2);
  assert.equal(f.counts.get('retry-a'), 1, 'The successful gallery is not downloaded twice');
  assert.equal(f.counts.get('retry-b'), 2);
  assert.deepEqual(jobQueue.get(retryId)!.payload.mergeDownloadIds, checkpoints);
  assert.equal((await fields(f.existing)).Number, '9');
});

test('invalid staged target edits reject the plan before any gallery download', async () => {
  const f = fixture('invalid');
  const job = runningJob({ seriesId: 50, existingChapters: { [f.existing]: '0' }, downloads: [plan('never-downloaded')] });
  await assert.rejects(runJob(job, () => {}), /positive numbers or blank/);
  assert.equal(f.counts.size, 0);
  assert.equal(downloadQueue.findActive('hitomi', 'never-downloaded'), null);
  assert.equal((await fields(f.existing)).Number, '12');
});

test('canceling a waiting merge stops its owned task and leaves independent downloads alone', async t => {
  fixture('cancel');
  const job = runningJob({ downloads: [plan('owned-paused'), plan('independent-paused', '14')] });
  const oldArchive = path.join(dataDir, 'old-independent.cbz');
  archive(oldArchive, '5');
  getDb().insert(schema.downloadQueue).values({ source: 'hitomi', galleryId: 'independent-paused', status: 'completed', outputFormat: 'cbz', outputPath: oldArchive }).run();
  const ownedId = Number(getDb().insert(schema.downloadQueue).values({ source: 'hitomi', galleryId: 'owned-paused', status: 'paused', outputFormat: 'cbz', mergeJobId: job.id }).run().lastInsertRowid);
  const independentId = Number(getDb().insert(schema.downloadQueue).values({ source: 'hitomi', galleryId: 'independent-paused', status: 'paused', outputFormat: 'cbz' }).run().lastInsertRowid);
  job.payload.mergeDownloadIds = { 'hitomi:owned-paused': ownedId };
  await assert.rejects(clock(t, async () => {
    const result = prepareMergeDownloads(job, () => {});
    jobQueue.cancel(job.id);
    return result;
  }), JobCancelled);
  assert.equal(downloadQueue.get(ownedId)!.errorMessage, 'Cancelled by user');
  assert.equal(downloadQueue.get(independentId)!.status, 'paused');
  assert.equal(job.payload.mergeDownloadIds['hitomi:independent-paused'], independentId, 'An active download takes precedence over an older completed copy');
  downloadQueue.cancel(independentId);
});

test('jobs API rejects malformed download plans before persisting or enqueueing work', async () => {
  const before = jobQueue.list().length;
  for (const downloads of [{}, [plan('invalid', '0')], [plan('invalid', '-2')], [plan('invalid', '1e3')], [{ ...plan('invalid'), source: 'unknown' }], [{ ...plan('invalid'), source: '__proto__' }], [plan('same'), plan('same')]]) {
    const response = await api.request('/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'merge-series', seriesId: 50, downloads }) });
    assert.equal(response.status, 400);
  }
  assert.equal(jobQueue.list().length, before);
});

test('merge retry can replace a failed independent download without changing its original task', async t => {
  const f = fixture('independent-retry');
  const independentId = Number(getDb().insert(schema.downloadQueue).values({ source: 'hitomi', galleryId: 'failed-independent', status: 'failed', outputFormat: 'cbz', errorMessage: 'Cancelled by user' }).run().lastInsertRowid);
  const job = runningJob({ seriesId: 50, downloads: [plan('failed-independent')], mergeDownloadIds: { 'hitomi:failed-independent': independentId } });
  await clock(t, () => runJob(job, () => {}));
  assert.equal(downloadQueue.get(independentId)!.errorMessage, 'Cancelled by user');
  const completed = downloadQueue.findCompleted('hitomi', 'failed-independent')!;
  assert.notEqual(completed.id, independentId);
  assert.equal(path.dirname(completed.outputPath!), f.target);
});

test('another active merge retains ownership of its queued galleries', async () => {
  fixture('other-merge');
  const owner = runningJob({ downloads: [plan('owned-elsewhere')] });
  const taskId = Number(getDb().insert(schema.downloadQueue).values({ source: 'hitomi', galleryId: 'owned-elsewhere', status: 'paused', outputFormat: 'cbz', mergeJobId: owner.id }).run().lastInsertRowid);
  const job = runningJob({ downloads: [plan('owned-elsewhere')] });
  await assert.rejects(prepareMergeDownloads(job, () => {}), /already assigned to merge job/);
  assert.equal(downloadQueue.get(taskId)!.status, 'paused');
  downloadQueue.cancel(taskId);
});
