import { prepareDuplicateCheck, findDuplicateReports, lookupLibraryMatches } from '../../services/galleryDuplicates.js';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import fs from 'node:fs';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { getDb, schema } from '../../db/index.js';
import { getDownloaderSettings } from '../../services/settings.js';
import { downloadQueue } from '../../downloader/engine.js';
import { getDoujinProvider } from '../../downloader/providers.js';
import { type DoujinSource } from '../../downloader/types.js';
import { listCbzFiles, readCoverImage } from '../../lib/cbz.js';
import { galleryFilesystemName, sanitizeFilename } from '../../downloader/util.js';
import { mapLimit } from '../../lib/http.js';

import { errMsg, intParam } from './helpers.js';
export const api = new Hono();
api.post('/downloads/library-matches', async (c) => {
  const body = await c.req.json() as { items?: unknown[] };
  if (!Array.isArray(body.items) || !body.items.length || body.items.length > 100) return c.json({ error: 'Provide 1–100 galleries to check.' }, 400);
  const items = [];
  for (const raw of body.items) {
    const item = raw as { source: DoujinSource; galleryId: string; title: string; artists: string[]; language?: string; pageCount?: number } | null;
    if (!item || getDoujinProvider(item.source)?.id !== item.source || typeof item.galleryId !== 'string' || !item.galleryId.trim() || typeof item.title !== 'string' || !Array.isArray(item.artists) || item.artists.some(artist => typeof artist !== 'string') || (item.language !== undefined && typeof item.language !== 'string') || (item.pageCount !== undefined && (typeof item.pageCount !== 'number' || !Number.isFinite(item.pageCount) || item.pageCount < 0))) return c.json({ error: 'Invalid gallery metadata.' }, 400);
    items.push({ source: item.source, galleryId: item.galleryId, title: item.title, artists: item.artists, language: item.language, pageCount: item.pageCount });
  }
  try { return c.json(await lookupLibraryMatches(items)); }
  catch (error) { return c.json({ error: 'Could not check library matches', message: errMsg(error) }, 502); }
});

api.post('/downloads/duplicates', async (c) => {
  const body = await c.req.json() as { items?: { source: DoujinSource; galleryId: string }[]; refreshLibrary?: boolean };
  if (!Array.isArray(body.items) || !body.items.length || body.items.length > 100 || body.items.some(item => !item || getDoujinProvider(item.source)?.id !== item.source || typeof item.galleryId !== 'string' || !item.galleryId.trim())) return c.json({ error: 'Provide 1–100 supported galleries to check.' }, 400);
  try { return c.json(findDuplicateReports(await prepareDuplicateCheck(body.items, body.refreshLibrary === true))); }
  catch (error) { return c.json({ error: 'Could not check for duplicates', message: errMsg(error) }, 502); }
});

type DownloadInput = { source: string; galleryId: string; title?: string; format?: 'cbz' | 'folder'; mergeFolder?: string; chapter?: number; priority?: number; allowDuplicate?: boolean };

/** Resolve and validate before starting workers, so a batch is registered together. */
async function prepareDownload(body: DownloadInput): Promise<Response | (() => Response)> {
  const respond = (value: unknown, status: number) => Response.json(value, { status });
  if (!body || typeof body !== 'object' || typeof body.source !== 'string' || typeof body.galleryId !== 'string' || !body.source || !body.galleryId.trim()) return respond({ error: 'source and galleryId are required' }, 400);
  if (getDoujinProvider(body.source)?.id !== body.source) return respond({ error: `Unknown source: ${body.source}` }, 400);
  // Merge options: all chapters of one series land in a shared folder so Kavita
  // groups them together. mergeFolder is a plain folder name, never a path.
  if (body.mergeFolder !== undefined && typeof body.mergeFolder !== 'string') return respond({ error: 'mergeFolder must be a plain folder name' }, 400);
  const mergeFolder = body.mergeFolder?.trim() || undefined;
  if (mergeFolder && /[\\/]/.test(mergeFolder)) return respond({ error: 'mergeFolder must be a plain folder name' }, 400);
  const downloaderSettings = getDownloaderSettings();
  const outputFormat = body.format ?? downloaderSettings.format;
  if (outputFormat !== 'cbz' && outputFormat !== 'folder') return respond({ error: 'format must be cbz or folder' }, 400);
  if (mergeFolder && outputFormat === 'folder') return respond({ error: 'Merged downloads require CBZ output' }, 400);
  const chapter = typeof body.chapter === 'number' && Number.isFinite(body.chapter) ? body.chapter : undefined;
  // Duplicate guard: a completed task for this gallery already exists. Re-downloading
  // is possible via the queue's Retry action, which re-runs the stored task.
  const done = downloadQueue.findCompleted(body.source as DoujinSource, body.galleryId);
  if (done) return respond({ error: 'already-downloaded', message: 'A completed task for this gallery already exists — use Retry in the Download Manager to re-download it.', finishedAt: done.finishedAt ?? null }, 409);
  // Also block duplicates that are queued/downloading/paused (retrying one of
  // those goes through the task's own Retry action, not a new enqueue).
  const active = downloadQueue.findActive(body.source as DoujinSource, body.galleryId);
  if (active) return respond({ error: 'already-queued', message: 'This gallery is already queued or downloading.', status: active.status }, 409);
  const owned = getDb().select().from(schema.ownedGalleries).where(and(eq(schema.ownedGalleries.source, body.source), eq(schema.ownedGalleries.galleryId, body.galleryId))).get();
  if (owned) return respond({ error: 'already-downloaded', message: 'This gallery is already owned, even if its download history was cleared.' }, 409);
  if (!downloaderSettings.downloadDirectory.trim()) return respond({ error: 'Set an output folder in Downloader settings before starting a download.' }, 400);
  // Queue priority: higher runs first; ties keep FIFO order. Defaults to 0.
  const priority = typeof body.priority === 'number' && Number.isFinite(body.priority) ? Math.trunc(body.priority) : 0;
  try {
    const identities = await prepareDuplicateCheck([{ source: body.source as DoujinSource, galleryId: body.galleryId }]);
    return () => {
      // Another request can finish its preflight while the batch is resolving.
      if (downloadQueue.findCompleted(body.source as DoujinSource, body.galleryId)
        || getDb().select().from(schema.ownedGalleries).where(and(eq(schema.ownedGalleries.source, body.source), eq(schema.ownedGalleries.galleryId, body.galleryId))).get()) return respond({ error: 'already-downloaded' }, 409);
      if (downloadQueue.findActive(body.source as DoujinSource, body.galleryId)) return respond({ error: 'already-queued' }, 409);
      const check = findDuplicateReports(identities);
      if (body.allowDuplicate !== true && check.reports.some(report => report.matches.length)) return respond({ error: 'possible-duplicate', ...check }, 409);
      const id = downloadQueue.enqueue(body.source as DoujinSource, body.galleryId, identities[0].title, outputFormat, mergeFolder, chapter, priority);
      return respond({ id, status: 'queued' }, 202);
    };
  } catch (error) { return respond({ error: 'Could not check for duplicates', message: errMsg(error) }, 502); }
}

/** Enqueue a gallery download. */
api.post('/downloads', async (c) => {
  const prepared = await prepareDownload(await c.req.json());
  return typeof prepared === 'function' ? prepared() : prepared;
});

/** Prepare the entire merged selection before any chapter can complete. */
api.post('/downloads/merged', async (c) => {
  const body = await c.req.json();
  if (typeof body?.mergeFolder !== 'string' || !body.mergeFolder.trim() || /[\\/]/.test(body.mergeFolder)) return c.json({ error: 'mergeFolder must be a plain folder name' }, 400);
  if (!Array.isArray(body.items) || !body.items.length || body.items.length > 100
    || body.items.some((item: DownloadInput) => !item || typeof item.source !== 'string' || typeof item.galleryId !== 'string')
    || new Set(body.items.map((item: DownloadInput) => `${item.source}:${item.galleryId}`)).size !== body.items.length) return c.json({ error: 'Provide 1–100 distinct galleries.' }, 400);
  const prepared = await mapLimit(body.items as DownloadInput[], 3, item => prepareDownload({ ...item, format: 'cbz', mergeFolder: body.mergeFolder }));
  // No await between inserts: every sibling exists before a worker can finish.
  const responses = prepared.map(item => typeof item === 'function' ? item() : item);
  const items = await Promise.all(responses.map(async (response, index) => ({
    source: body.items[index].source, galleryId: body.items[index].galleryId, ...(await response.json() as Record<string, unknown>),
  })));
  return c.json({ items }, 202);
});

api.get('/downloads', (c) => c.json(downloadQueue.list(100)));

/** Completed galleries (source + galleryId + finish time) for duplicate badges. */
api.get('/downloads/completed', (c) => c.json(downloadQueue.completedGalleries()));

/**
 * Resolve the .cbz file(s) on disk for a gallery. Completed task rows win; when
 * the history was cleared (or the download predates the queue), fall back to the
 * per-gallery folder that writeOutput derives from the sanitized title.
 */
api.get('/downloads/gallery-files', (c) => {
  const source = c.req.query('source');
  const galleryId = c.req.query('galleryId');
  const title = c.req.query('title') ?? '';
  if (!source || !galleryId) return c.json({ error: 'source and galleryId are required' }, 400);
  let files: string[] = [];
  const done = downloadQueue.findCompleted(source as DoujinSource, galleryId);
  if (done?.outputPath?.toLowerCase().endsWith('.cbz') && fs.existsSync(done.outputPath)) {
    files = [done.outputPath];
  } else if (title.trim()) {
    const dl = getDownloaderSettings();
    if (dl.downloadDirectory) {
      const base = path.resolve(dl.downloadDirectory);
      const candidates = [
        path.join(base, galleryFilesystemName(title, source, galleryId)),
        path.join(base, sanitizeFilename(title, `Gallery-${galleryId}`)),
      ];
      for (const dir of candidates) {
        try {
          files = listCbzFiles(dir);
        } catch {
          /* try the legacy title-only directory */
        }
        if (files.length > 0) break;
      }
    }
  }
  return c.json({ files });
});

/**
 * Server-Sent Events stream of live download-task updates. The client receives
 * an initial `snapshot` of every task, then a `task` event each time a tracked
 * field changes (throttled server-side). Used for real-time progress without
 * polling; the REST endpoints remain as the fallback/authoritative source.
 */
api.get('/downloads/events', (c) =>
  streamSSE(c, async (sse) => {
    // Push the current state immediately so a freshly-opened client is up to date.
    await sse.write(`data: ${JSON.stringify({ type: 'snapshot', tasks: downloadQueue.list(100) })}\n\n`);

    const unsubscribe = downloadQueue.subscribe((task) => {
      void sse.write(`data: ${JSON.stringify({ type: 'task', task })}\n\n`).catch(() => {});
    });
    const unsubscribeRemovals = downloadQueue.subscribeRemovals((ids) => {
      void sse.write(`data: ${JSON.stringify({ type: 'removed', ids })}\n\n`).catch(() => {});
    });

    // Keep the connection alive so proxies/clients don't time out during idle.
    const heartbeat = setInterval(() => {
      void sse.write(': ping\n\n').catch(() => {});
    }, 15_000);

    await new Promise<void>((resolve) => {
      c.req.raw.signal.addEventListener('abort', () => resolve(), { once: true });
    });

    clearInterval(heartbeat);
    unsubscribe();
    unsubscribeRemovals();
  }),
);

api.get('/downloads/:id', (c) => {
  const id = intParam(c.req.param('id'));
  if (id === null) return c.json({ error: 'Invalid download id' }, 400);
  const task = downloadQueue.get(id);
  if (!task) return c.json({ error: 'Download not found' }, 404);
  return c.json(task);
});

/**
 * Cover thumbnail for a completed download: the first image of its .cbz (or
 * output folder), read locally so history rows show covers without any
 * provider round-trip. Served same-origin, so the session cookie authenticates it.
 */
api.get('/downloads/:id/cover', async (c) => {
  const id = intParam(c.req.param('id'));
  if (id === null) return c.json({ error: 'Invalid download id' }, 400);
  const task = downloadQueue.get(id);
  if (!task || task.status !== 'completed' || !task.outputPath) return c.json({ error: 'No cover available' }, 404);
  const img = await readCoverImage(task.outputPath);
  if (!img) return c.json({ error: 'No cover available' }, 404);
  return new Response(img.data, {
    headers: { 'Content-Type': img.mime, 'Cache-Control': 'private, max-age=86400' } });
});

const DOWNLOAD_ACTIONS = ['pause', 'resume', 'cancel', 'retry'] as const;
for (const action of DOWNLOAD_ACTIONS) {
  api.post(`/downloads/:id/${action}`, (c) => {
    const id = intParam(c.req.param('id'));
    if (id === null) return c.json({ error: 'Invalid download id' }, 400);
    const ok = downloadQueue[action](id);
    if (!ok) return c.json({ error: `Could not ${action} download` }, 400);
    return c.json({ ok: true });
  });
}

api.delete('/downloads/:id', (c) => {
  const id = intParam(c.req.param('id'));
  if (id === null) return c.json({ error: 'Invalid download id' }, 400);
  const task = downloadQueue.get(id);
  if (!task) return c.json({ error: 'Download not found' }, 404);
  if (downloadQueue.isRunning(id) || task.status === 'queued' || task.status === 'downloading' || task.status === 'paused') {
    return c.json({ error: 'Active downloads must be cancelled before removal' }, 409);
  }
  downloadQueue.remove(id);
  return c.json({ ok: true });
});

api.post('/downloads/clear-completed', (c) => {
  const removed = downloadQueue.clearCompleted();
  return c.json({ ok: true, removed });
});

// ---------------- Library overrides ----------------
