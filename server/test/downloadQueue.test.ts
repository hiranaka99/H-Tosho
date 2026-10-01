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

test('start recovers interrupted downloads and processes persisted queued work', async () => {
  const interrupted = getDb()
    .insert(schema.downloadQueue)
    .values({ source: 'hitomi', galleryId: 'old', status: 'downloading', outputFormat: 'cbz' })
    .run();
  const queued = getDb()
    .insert(schema.downloadQueue)
    .values({ source: 'hitomi', galleryId: 'next', status: 'queued', outputFormat: 'cbz' })
    .run();

  doujinProviders.hitomi = {
    id: 'hitomi',
    name: 'Hitomi',
    color: '#000',
    async search() { return []; },
    async getGallery(idOrUrl) {
      return { source: 'hitomi', galleryId: idOrUrl, title: 'Recovered', tags: [], artists: [], pages: ['https://example.test/page.jpg'] };
    },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(Buffer.from('image'))) as typeof fetch;

  try {
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
    const interruptedId = Number(interrupted.lastInsertRowid);
    const queuedId = Number(queued.lastInsertRowid);
    const completedQueued = waitForStatus(queue, queuedId, 'completed');
    const completedInterrupted = waitForStatus(queue, interruptedId, 'completed');
    queue.start();

    await Promise.all([completedQueued, completedInterrupted]);
    // Interrupted rows now resume: start() re-queues them instead of failing.
    assert.equal(queue.get(interruptedId)?.status, 'completed');
    assert.equal(queue.get(queuedId)?.status, 'completed');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

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
