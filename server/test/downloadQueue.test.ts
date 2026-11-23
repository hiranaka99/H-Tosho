import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { galleryFilesystemName } from '../src/downloader/util.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'htosho-download-queue-'));
const outputDir = path.join(dataDir, 'output');
process.env.HTOSHO_DATA_DIR = dataDir;

// Dynamic imports are required here: the DB module snapshots HTOSHO_DATA_DIR at module load.
const { initDb, getDb, schema } = await import('../src/db/index.js');
const { DownloadQueue } = await import('../src/downloader/engine.js');
const { doujinProviders } = await import('../src/downloader/providers.js');
const originalHitomi = doujinProviders.hitomi;

initDb();
after(() => {
  doujinProviders.hitomi = originalHitomi;
});

function waitForStatus(queue: InstanceType<typeof DownloadQueue>, id: number, status: string): Promise<void> {
  // DownloadQueue exposes callbacks rather than an EventEmitter; adapt that API once for deterministic tests.
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

test('a task keeps its enqueue-time output format when settings later change', async () => {
  const queue = new DownloadQueue(() => ({
    downloadDirectory: outputDir,
    format: 'folder',
    maxConcurrentDownloads: 1,
    maxImageConcurrency: 1,
    requestDelayMs: 0,
    autoSyncKavita: false,
    nhentaiApiKey: '',
    nhentaiBannedTags: [],
  }));
  doujinProviders.hitomi = {
    ...originalHitomi,
    async getGallery(idOrUrl) {
      return { source: 'hitomi', galleryId: idOrUrl, title: 'Format', tags: [], artists: [], pages: ['https://example.test/page.jpg'] };
    },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(Buffer.from('image'))) as typeof fetch;

  try {
    const id = queue.enqueue('hitomi', 'format', null, 'cbz');
    await waitForStatus(queue, id, 'completed');
    const task = queue.get(id)!;
    assert.equal(task.outputFormat, 'cbz');
    assert.match(task.outputPath ?? '', /\.cbz$/);
    assert.ok(fs.statSync(task.outputPath!).isFile());
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('resuming a failed task clears its old failure before downloading again', async () => {
  let releaseGallery!: () => void;
  const galleryGate = new Promise<void>((resolve) => { releaseGallery = resolve; });
  doujinProviders.hitomi = {
    ...originalHitomi,
    async getGallery(idOrUrl) {
      await galleryGate;
      return { source: 'hitomi', galleryId: idOrUrl, title: 'Resumed', tags: [], artists: [], pages: ['https://example.test/page.jpg'] };
    },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(Buffer.from('image'))) as typeof fetch;
  const id = Number(getDb().insert(schema.downloadQueue).values({
    source: 'hitomi', galleryId: 'resume-failed', status: 'failed', outputFormat: 'cbz',
    errorMessage: 'Previous CDN error', finishedAt: '2024-01-01T00:00:00.000Z',
  }).run().lastInsertRowid);
  const queue = new DownloadQueue(() => ({
    downloadDirectory: outputDir,
    format: 'cbz',
    maxConcurrentDownloads: 1,
    maxImageConcurrency: 1,
    requestDelayMs: 0,
    autoSyncKavita: false,
    nhentaiApiKey: '',
    nhentaiBannedTags: [],
  }));
  const completed = waitForStatus(queue, id, 'completed');
  try {
    assert.equal(queue.resume(id), true);
    assert.equal(queue.get(id)?.status, 'downloading');
    assert.equal(queue.get(id)?.errorMessage, null);
    assert.equal(queue.get(id)?.finishedAt, null);
    releaseGallery();
    await completed;
    assert.equal(queue.get(id)?.errorMessage, null);
  } finally {
    releaseGallery();
    await completed;
    globalThis.fetch = originalFetch;
  }
});

test('cancelling staged folder output preserves existing media and unrelated files', async () => {
  const target = path.join(outputDir, galleryFilesystemName('Existing gallery', 'hitomi', 'cancel-staged'));
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, '001.jpg'), 'old image');
  fs.writeFileSync(path.join(target, 'user-notes.txt'), 'keep my notes');
  doujinProviders.hitomi = {
    ...originalHitomi,
    async getGallery(idOrUrl) {
      return { source: 'hitomi', galleryId: idOrUrl, title: 'Existing gallery', tags: [], artists: [], pages: ['https://example.test/page.jpg'] };
    },
  };
  const originalFetch = globalThis.fetch;
  const copyFile = fs.promises.copyFile;
  let releaseCopy!: () => void;
  let reachedCopy!: () => void;
  const copyGate = new Promise<void>((resolve) => { releaseCopy = resolve; });
  const stagingStarted = new Promise<void>((resolve) => { reachedCopy = resolve; });
  fs.promises.copyFile = async (...args) => {
    reachedCopy();
    await copyGate;
    return copyFile(...args);
  };
  globalThis.fetch = (async () => new Response(Buffer.from('new image'))) as typeof fetch;
  const queue = new DownloadQueue(() => ({ downloadDirectory: outputDir, format: 'folder', maxConcurrentDownloads: 1, maxImageConcurrency: 1, requestDelayMs: 0, autoSyncKavita: false, nhentaiApiKey: '', nhentaiBannedTags: [] }));
  let unsubscribe = () => {};
  const settled = new Promise<void>((resolve) => {
    unsubscribe = queue.subscribe((task) => {
      if (task.galleryId === 'cancel-staged' && task.status === 'failed' && !queue.isRunning(task.id)) resolve();
    });
  });
  try {
    const id = queue.enqueue('hitomi', 'cancel-staged', null, 'folder');
    await stagingStarted;
    assert.equal(queue.cancel(id), true);
    releaseCopy();
    await settled;
    assert.equal(queue.get(id)?.errorMessage, 'Cancelled by user');
    assert.equal(fs.readFileSync(path.join(target, '001.jpg'), 'utf8'), 'old image');
    assert.equal(fs.readFileSync(path.join(target, 'user-notes.txt'), 'utf8'), 'keep my notes');
    assert.equal(fs.readdirSync(outputDir).some((name) => name.startsWith('.htosho-download-')), false);
  } finally {
    releaseCopy();
    unsubscribe();
    fs.promises.copyFile = copyFile;
    globalThis.fetch = originalFetch;
  }
});

test('re-download replaces an existing CBZ when the platform does not overwrite on rename', async () => {
  const title = 'Replace existing archive';
  const galleryId = 'replace-existing';
  const targetDir = path.join(outputDir, galleryFilesystemName(title, 'hitomi', galleryId));
  const targetFile = path.join(targetDir, `${galleryFilesystemName(title, 'hitomi', galleryId)}.cbz`);
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(targetFile, 'old archive');
  doujinProviders.hitomi = {
    ...originalHitomi,
    async getGallery(idOrUrl) {
      return { source: 'hitomi', galleryId: idOrUrl, title, tags: [], artists: [], pages: ['https://example.test/page.jpg'] };
    },
  };
  const originalFetch = globalThis.fetch;
  const rename = fs.promises.rename;
  globalThis.fetch = (async () => new Response(Buffer.from('new image'))) as typeof fetch;
  // Model Windows' rename behavior: publishing directly over an existing file
  // is rejected, while moving the old file aside first is permitted.
  fs.promises.rename = async (from, to) => {
    if (fs.existsSync(to)) {
      const error = Object.assign(new Error('destination exists'), { code: 'EEXIST' });
      throw error;
    }
    return rename(from, to);
  };
  try {
    const queue = new DownloadQueue(() => ({ downloadDirectory: outputDir, format: 'cbz', maxConcurrentDownloads: 1, maxImageConcurrency: 1, requestDelayMs: 0, autoSyncKavita: false, nhentaiApiKey: '', nhentaiBannedTags: [] }));
    const id = queue.enqueue('hitomi', galleryId, null, 'cbz');
    await waitForStatus(queue, id, 'completed');
    assert.notEqual(fs.readFileSync(targetFile, 'utf8'), 'old archive');
  } finally {
    fs.promises.rename = rename;
    globalThis.fetch = originalFetch;
  }
});


test('startup restores durable retry deadlines and does not duplicate timers on repeated start', async () => {
  const row = getDb().insert(schema.downloadQueue).values({ source: 'hitomi', galleryId: 'durable-retry', status: 'failed', outputFormat: 'cbz', errorCode: 'network', retryCount: 1, retryAt: new Date(Date.now() + 60_000).toISOString() }).run();
  const queue = new DownloadQueue(() => ({ downloadDirectory: '', format: 'cbz', maxConcurrentDownloads: 1, maxImageConcurrency: 1, requestDelayMs: 0, autoSyncKavita: false, nhentaiApiKey: '', nhentaiBannedTags: [] }));
  const id = Number(row.lastInsertRowid);
  queue.start();
  queue.start();
  assert.equal(queue.get(id)!.state.type, 'retry-wait');
  assert.equal(queue.hasPendingRetry(id), true);
  assert.equal(queue.findActive('hitomi', 'durable-retry')!.id, id);
  assert.equal(queue.cancel(id), true);
  assert.equal(queue.get(id)!.state.type, 'cancelled');
  assert.equal(queue.get(id)!.retryAt, null);
  assert.equal(queue.hasPendingRetry(id), false);
  queue.remove(id);
});


test('retry output ownership protects edits until a cancelled download unwinds', async () => {
  const { buildZip } = await import('../src/downloader/zip.js');
  const { editComicInfo, readComicInfo } = await import('../src/lib/cbz.js');
  const previous = path.join(outputDir, 'owned-before-retry.cbz');
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(previous, buildZip([{ name: '001.jpg', data: Buffer.from('old image') }, { name: 'ComicInfo.xml', data: Buffer.from('<ComicInfo><Series>Old</Series></ComicInfo>') }]));
  const row = getDb().insert(schema.downloadQueue).values({ source: 'hitomi', galleryId: 'reserved-output', status: 'completed', outputFormat: 'cbz', outputPath: previous }).run();
  const id = Number(row.lastInsertRowid);
  const queue = new DownloadQueue(() => ({ downloadDirectory: outputDir, format: 'cbz', maxConcurrentDownloads: 1, maxImageConcurrency: 1, requestDelayMs: 0, autoSyncKavita: false, nhentaiApiKey: '', nhentaiBannedTags: [] }));
  const originalFetch = globalThis.fetch;
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), settled = Promise.withResolvers<void>();
  globalThis.fetch = (async () => { entered.resolve(); await release.promise; return new Response(Buffer.from('new image')); }) as typeof fetch;
  const unsubscribe = queue.subscribe(task => { if (task.id === id && task.status === 'failed' && !queue.isRunning(id)) settled.resolve(); });
  try {
    assert.equal(queue.retry(id), true);
    await entered.promise;
    let edited = false;
    const edit = editComicInfo(previous, { fields: { Number: '7' } }).then(() => { edited = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(edited, false, 'edit crossed an active retry reservation');
    queue.cancel(id);
    release.resolve();
    await settled.promise;
    await edit;
    assert.match((await readComicInfo(previous))!, /<Number>(?:<!\[CDATA\[)?7(?:\]\]>)?<\/Number>/);
    assert.equal(queue.get(id)!.state.type, 'cancelled');
  } finally { release.resolve(); unsubscribe(); globalThis.fetch = originalFetch; }
});
