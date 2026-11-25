import { prepareDuplicateCheck, findDuplicateReports, lookupLibraryMatches, createDuplicateChecker, type DuplicateChecker } from '../../services/galleryDuplicates.js';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { and, eq, inArray } from 'drizzle-orm';
import { getDb, schema } from '../../db/index.js';
import { getDownloaderSettings } from '../../services/settings.js';
import { downloadQueue } from '../../downloader/engine.js';
import { getDoujinProvider } from '../../downloader/providers.js';
import { type DoujinSource } from '../../contracts/doujin.js';
import { listCbzFiles, readCoverImage } from '../../lib/cbz.js';
import { galleryFilesystemName, sanitizeFilename } from '../../downloader/util.js';
import { mapLimit } from '../../lib/http.js';
import { jobQueue } from '../../jobs/queue.js';
import type { MergeProtectionState } from '../../contracts/mergeProtection.js';
import { resolveMergeProtection, requireMergeProtection, MergeProtectionError } from '../../services/mergeProtection.js';

import { downloadLibraryStates } from '../../services/downloadLibraryState.js';
import { connectedClient, errMsg, intParam } from './helpers.js';
export const api = new Hono();
api.post('/downloads/library-matches', async (c) => {
  const body = await c.req.json() as { items?: unknown[] } | null;
  if (!body || !Array.isArray(body.items) || !body.items.length || body.items.length > 100) return c.json({ error: 'Provide 1–100 galleries to check.' }, 400);
  const items = [];
  for (const raw of body.items) {
    const item = raw as { source: DoujinSource; galleryId: string; title: string; artists: string[]; language?: string; pageCount?: number; tags?: unknown } | null;
    if (item && item.tags !== undefined && (!Array.isArray(item.tags) || item.tags.length > 500 || item.tags.some(tag => typeof tag !== 'string'))) return c.json({ error: 'Invalid gallery metadata.' }, 400);
    if (!item || getDoujinProvider(item.source)?.id !== item.source || typeof item.galleryId !== 'string' || !item.galleryId.trim() || typeof item.title !== 'string' || !Array.isArray(item.artists) || item.artists.some(artist => typeof artist !== 'string') || (item.language !== undefined && typeof item.language !== 'string') || (item.pageCount !== undefined && (typeof item.pageCount !== 'number' || !Number.isFinite(item.pageCount) || item.pageCount < 0))) return c.json({ error: 'Invalid gallery metadata.' }, 400);
    // Tags only inform the censorship edition (better-edition badges); they are never stored.
    items.push({ source: item.source, galleryId: item.galleryId, title: item.title, artists: item.artists, language: item.language, pageCount: item.pageCount, ...(Array.isArray(item.tags) ? { tags: item.tags as string[] } : {}) });
  }
  try { return c.json(await lookupLibraryMatches(items)); }
  catch (error) { return c.json({ error: 'Could not check library matches', message: errMsg(error) }, 502); }
});

api.post('/downloads/duplicates', async (c) => {
  const body = await c.req.json() as { items?: { source: DoujinSource; galleryId: string; url?: string }[]; refreshLibrary?: boolean } | null;
  if (!body || !Array.isArray(body.items) || !body.items.length || body.items.length > 100 || body.items.some(item => !item || getDoujinProvider(item.source)?.id !== item.source || typeof item.galleryId !== 'string' || !item.galleryId.trim() || (item.url !== undefined && typeof item.url !== 'string'))) return c.json({ error: 'Provide 1–100 supported galleries to check.' }, 400);
  const items: { source: DoujinSource; galleryId: string; url?: string }[] = [];
  for (const item of body.items) {
    let validUrl: string | undefined;
    if (item.url !== undefined) {
      try {
        const parsed = new URL(item.url);
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('bad protocol');
        validUrl = parsed.toString();
      } catch {
        return c.json({ error: 'url must be an absolute http(s) URL' }, 400);
      }
    }
    items.push({ source: item.source, galleryId: item.galleryId, ...(validUrl ? { url: validUrl } : {}) });
  }
  try { return c.json(findDuplicateReports(await prepareDuplicateCheck(items, body.refreshLibrary === true))); }
  catch (error) { return c.json({ error: 'Could not check for duplicates', message: errMsg(error) }, 502); }
});

type DownloadInput = { source: string; galleryId: string; url?: string; title?: string; format?: 'cbz' | 'folder'; mergeFolder?: string; chapter?: number; priority?: number; allowDuplicate?: boolean };
interface MergeDownloadGroup {
  protection: MergeProtectionState;
  plans: {source:DoujinSource;galleryId:string;title:string;chapter:string;allowDuplicate:boolean;url?:string}[];
  ids: Record<string,number>;
}

async function prepareMergeGroup(folder: string): Promise<MergeDownloadGroup> {
  const client = connectedClient();
  if (!folder.trim() || /[\\/\u0000-\u001f\u007f]/.test(folder)) throw new MergeProtectionError('mergeFolder must be a plain series name without control characters',400);
  if (!client) throw new MergeProtectionError('Kavita is required to review merged download protection');
  const dl = getDownloaderSettings();
  if (!dl.downloadDirectory.trim()) throw new MergeProtectionError('Set an output folder in Downloader settings before starting merged downloads',400);
  const targetDir = path.join(path.resolve(dl.downloadDirectory),sanitizeFilename(folder,'merged'));
  const reviewed = await resolveMergeProtection(client,{targetDir,seriesName:folder});
  requireMergeProtection(reviewed.preview);
  return {protection:reviewed.state,plans:[],ids:{}};
}

/** Siblings are registered before one protected merge commitment can start. */
function commitMergeGroup(group: MergeDownloadGroup): void {
  if (!group.plans.length) return;
  const id = jobQueue.enqueue('merge-series',{targetDir:group.protection.targetDir,seriesName:group.protection.seriesName,downloads:group.plans});
  jobQueue.updateMergeState(id,{mergeProtection:group.protection,mergeDownloadIds:group.ids});
  getDb().update(schema.downloadQueue).set({mergeJobId:id}).where(inArray(schema.downloadQueue.id,Object.values(group.ids))).run();
}

/** Resolve and validate before starting workers, so a batch is registered together. */
async function prepareDownload(body: DownloadInput, group?: MergeDownloadGroup): Promise<Response | ((checker?: DuplicateChecker) => Response)> {
  const respond = (value: unknown, status: number) => Response.json(value, { status });
  if (!body || typeof body !== 'object' || typeof body.source !== 'string' || typeof body.galleryId !== 'string' || !body.source || !body.galleryId.trim()) return respond({ error: 'source and galleryId are required' }, 400);
  if (getDoujinProvider(body.source)?.id !== body.source) return respond({ error: `Unknown source: ${body.source}` }, 400);
  // The canonical gallery URL is frozen at enqueue time: the queued task keeps
  // resolving this origin even if the account/site changes later.
  let sourceUrl: string | undefined;
  if (body.url !== undefined) {
    if (typeof body.url !== 'string') return respond({ error: 'url must be an absolute http(s) URL' }, 400);
    try {
      const parsed = new URL(body.url);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('bad protocol');
      sourceUrl = parsed.toString();
    } catch {
      return respond({ error: 'url must be an absolute http(s) URL' }, 400);
    }
  }
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
  if (mergeFolder && body.chapter !== undefined && (typeof body.chapter !== 'number' || !Number.isFinite(body.chapter) || body.chapter <= 0)) return respond({error:'Merged chapter numbers must be positive numbers or blank'},400);
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
    const identities = await prepareDuplicateCheck([{ source: body.source as DoujinSource, galleryId: body.galleryId, ...(sourceUrl ? { url: sourceUrl } : {}) }]);
    // A batch passes one checker shared by all of its items (see /downloads/merged).
    return (checker?: DuplicateChecker) => {
      // Another request can finish its preflight while the batch is resolving.
      if (downloadQueue.findCompleted(body.source as DoujinSource, body.galleryId)
        || getDb().select().from(schema.ownedGalleries).where(and(eq(schema.ownedGalleries.source, body.source), eq(schema.ownedGalleries.galleryId, body.galleryId))).get()) return respond({ error: 'already-downloaded' }, 409);
      if (downloadQueue.findActive(body.source as DoujinSource, body.galleryId)) return respond({ error: 'already-queued' }, 409);
      const check = checker ? checker.check(identities) : findDuplicateReports(identities);
      if (body.allowDuplicate !== true && check.reports.some(report => report.matches.length)) return respond({ error: 'possible-duplicate', ...check }, 409);
      const id = downloadQueue.enqueue(body.source as DoujinSource, body.galleryId, identities[0].title, outputFormat, group ? undefined : mergeFolder, chapter, priority, undefined, sourceUrl);
      checker?.noteQueued(identities[0], id);
      if (group) {
        group.plans.push({source:body.source as DoujinSource,galleryId:body.galleryId,title:identities[0].title,chapter:chapter === undefined ? '' : String(chapter),allowDuplicate:body.allowDuplicate === true,url:sourceUrl});
        group.ids[`${body.source}:${body.galleryId}`] = id;
      }
      return respond({ id, status: 'queued' }, 202);
    };
  } catch (error) { return respond({ error: 'Could not check for duplicates', message: errMsg(error) }, 502); }
}

/** Enqueue a gallery download. */
api.post('/downloads', async (c) => {
  const body = await c.req.json() as DownloadInput | null;
  if (!body || typeof body !== 'object') return c.json({ error: 'source and galleryId are required' }, 400);
  if (body.mergeFolder && (body.format ?? getDownloaderSettings().format) === 'folder') return c.json({error:'Merged downloads require CBZ output'},400);
  try {
    const group = typeof body?.mergeFolder === 'string' && body.mergeFolder.trim() ? await prepareMergeGroup(body.mergeFolder.trim()) : undefined;
    const prepared = await prepareDownload(body,group);
    if (group) {
      const checked = await resolveMergeProtection(connectedClient()!,{targetDir:group.protection.targetDir,seriesName:group.protection.seriesName},group.protection);
      requireMergeProtection(checked.preview);
      group.protection = checked.state;
    }
    const response = typeof prepared === 'function' ? prepared() : prepared;
    if (group) commitMergeGroup(group);
    return response;
  } catch(error) { return c.json({error:errMsg(error)},error instanceof MergeProtectionError ? error.status : 502); }
});

/** Prepare the entire merged selection before any chapter can complete. */
api.post('/downloads/merged', async (c) => {
  const body = await c.req.json();
  if (typeof body?.mergeFolder !== 'string' || !body.mergeFolder.trim() || /[\\/]/.test(body.mergeFolder)) return c.json({ error: 'mergeFolder must be a plain folder name' }, 400);
  if (!Array.isArray(body.items) || !body.items.length || body.items.length > 100
    || body.items.some((item: DownloadInput) => !item || typeof item.source !== 'string' || typeof item.galleryId !== 'string')
    || new Set(body.items.map((item: DownloadInput) => `${item.source}:${item.galleryId}`)).size !== body.items.length) return c.json({ error: 'Provide 1–100 distinct galleries.' }, 400);
  let group: MergeDownloadGroup;
  try { group = await prepareMergeGroup(body.mergeFolder.trim()); }
  catch(error) { return c.json({error:errMsg(error)},error instanceof MergeProtectionError ? error.status : 502); }
  const prepared = await mapLimit(body.items as DownloadInput[], 3, item => prepareDownload({ ...item, format: 'cbz', mergeFolder: body.mergeFolder },group));
  try {
    const checked = await resolveMergeProtection(connectedClient()!,{targetDir:group.protection.targetDir,seriesName:group.protection.seriesName},group.protection);
    requireMergeProtection(checked.preview);
    group.protection = checked.state;
  } catch(error) { return c.json({error:errMsg(error)},error instanceof MergeProtectionError ? error.status : 502); }
  // No await between inserts and durable merge linkage. One duplicate snapshot
  // serves the whole batch; each enqueue is added to it, so later items still
  // see earlier ones exactly as a per-item check would.
  const checker = prepared.some(item => typeof item === 'function') ? createDuplicateChecker() : undefined;
  const responses = prepared.map(item => typeof item === 'function' ? item(checker) : item);
  commitMergeGroup(group);
  const items = await Promise.all(responses.map(async (response, index) => ({
    source: body.items[index].source, galleryId: body.items[index].galleryId, ...(await response.json() as Record<string, unknown>),
  })));
  return c.json({ items }, 202);
});

// Every active and failed task, plus the newest completed ones; older history is paged.
api.get('/downloads', (c) => c.json(downloadQueue.listForManager()));

/** Older completed downloads, newest finish first, with the full completed count. */
api.get('/downloads/history', (c) => {
  const offset = Math.max(0, Math.floor(Number(c.req.query('offset') ?? 0)) || 0);
  const limit = Math.min(100, Math.max(0, Math.floor(Number(c.req.query('limit') ?? 50)) || 0));
  return c.json(downloadQueue.completedHistory(offset, limit));
});

/** Kavita import state for completed downloads (`?ids=1,2,3`, at most 200). */
api.get('/downloads/library', (c) => {
  const ids = (c.req.query('ids') ?? '').split(',').map(Number).filter((id) => Number.isSafeInteger(id) && id > 0);
  return c.json(downloadLibraryStates(ids));
});

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

/** Open SSE streams, ended on server shutdown so the HTTP server can close promptly. */
const eventStreams = new Set<() => void>();
export function closeDownloadEventStreams(): void {
  for (const close of [...eventStreams]) close();
}

/**
 * Server-Sent Events stream of live download-task updates. The client receives
 * an initial `snapshot` of every task, then a `task` event each time a tracked
 * field changes (throttled server-side). Used for real-time progress without
 * polling; the REST endpoints remain as the fallback/authoritative source.
 */
api.get('/downloads/events', (c) =>
  streamSSE(c, async (sse) => {
    // Snapshot and subscription happen in one synchronous step, so no
    // broadcast can fall between them (the client merges by revision, so an
    // event repeating snapshot state is harmless). Stream writes are queued in
    // call order, so the snapshot still reaches the client first.
    const snapshot = `data: ${JSON.stringify({ type: 'snapshot', tasks: downloadQueue.listForManager() })}\n\n`;
    // serialized() is computed once per broadcast and shared by every client.
    const unsubscribe = downloadQueue.subscribe((_task, serialized) => {
      void sse.write(`data: {"type":"task","task":${serialized()}}\n\n`).catch(() => {});
    });
    const unsubscribeRemovals = downloadQueue.subscribeRemovals((ids) => {
      void sse.write(`data: ${JSON.stringify({ type: 'removed', ids })}\n\n`).catch(() => {});
    });
    // Push the current state immediately so a freshly-opened client is up to date.
    await sse.write(snapshot);

    // Keep the connection alive so proxies/clients don't time out during idle.
    const heartbeat = setInterval(() => {
      void sse.write(': ping\n\n').catch(() => {});
    }, 15_000);

    let close: () => void = () => {};
    await new Promise<void>((resolve) => {
      const signal = c.req.raw.signal;
      if (signal.aborted) return resolve();
      close = resolve;
      eventStreams.add(close);
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
    eventStreams.delete(close);

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
  const outputPath = task.outputPath;
  let stat: fs.Stats;
  try { stat = await fs.promises.stat(outputPath); }
  catch { return c.json({ error: 'No cover available' }, 404); }
  // An archive is rewritten as a whole, so its path, mtime and size identify
  // the cover. A folder's first image can change in place without touching the
  // folder's own mtime, so folder covers are tagged by their bytes and not cached.
  const archiveTag = stat.isDirectory() ? null : coverTag(JSON.stringify([outputPath, stat.mtimeMs, stat.size]));
  if (archiveTag && ifNoneMatch(c.req.header('If-None-Match'), archiveTag)) return coverNotModified(archiveTag);
  let cover = archiveTag ? coverCacheGet(archiveTag) : undefined;
  if (!cover) {
    const img = await readCoverImage(outputPath);
    if (!img) return c.json({ error: 'No cover available' }, 404);
    cover = { data: img.data, mime: img.mime, etag: archiveTag ?? coverTag(img.data) };
    if (archiveTag) coverCacheSet(archiveTag, cover);
    else if (ifNoneMatch(c.req.header('If-None-Match'), cover.etag)) return coverNotModified(cover.etag);
  }
  return new Response(cover.data, { headers: { 'Content-Type': cover.mime, ...coverHeaders(cover.etag) } });
});

/** Raw first pages are large; repeat thumbnail requests are served from memory. */
const COVER_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const coverCache = new Map<string, { data: Buffer; mime: string; etag: string }>();
let coverCacheBytes = 0;
function coverCacheGet(key: string) {
  const hit = coverCache.get(key);
  if (hit) { coverCache.delete(key); coverCache.set(key, hit); }
  return hit;
}
function coverCacheSet(key: string, value: { data: Buffer; mime: string; etag: string }): void {
  if (value.data.length > COVER_CACHE_MAX_BYTES / 4) return;
  const previous = coverCache.get(key);
  if (previous) { coverCacheBytes -= previous.data.length; coverCache.delete(key); }
  coverCache.set(key, value);
  coverCacheBytes += value.data.length;
  for (const [oldest, entry] of coverCache) {
    if (coverCacheBytes <= COVER_CACHE_MAX_BYTES) break;
    coverCache.delete(oldest);
    coverCacheBytes -= entry.data.length;
  }
}
const coverTag = (input: string | Buffer) => `"${createHash('sha1').update(input).digest('base64url')}"`;
const coverHeaders = (etag: string) => ({ ETag: etag, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
const coverNotModified = (etag: string) => new Response(null, { status: 304, headers: coverHeaders(etag) });
/** If-None-Match uses weak comparison: `W/` prefixes are ignored and `*` matches any tag. */
function ifNoneMatch(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  return header.split(',').some((candidate) => {
    const value = candidate.trim();
    return value === '*' || value.replace(/^W\//, '') === etag;
  });
}

const DOWNLOAD_ACTIONS = ['pause', 'resume', 'cancel', 'retry', 'prioritize'] as const;
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

api.post('/downloads/pause-all', (c) => {
  const count = downloadQueue.pauseAll();
  return c.json({ ok: true, count });
});

api.post('/downloads/resume-all', (c) => {
  const count = downloadQueue.resumeAll();
  return c.json({ ok: true, count });
});

api.post('/downloads/retry-failed', (c) => {
  const count = downloadQueue.retryFailed();
  return c.json({ ok: true, count });
});

api.post('/downloads/clear-completed', (c) => {
  const removed = downloadQueue.clearCompleted();
  return c.json({ ok: true, removed });
});

api.post('/downloads/clear-cancelled', (c) => {
  const removed = downloadQueue.clearCancelled();
  return c.json({ ok: true, removed });
});

// ---------------- Library overrides ----------------
