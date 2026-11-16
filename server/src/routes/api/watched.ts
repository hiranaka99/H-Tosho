import { Hono } from 'hono';
import { jobQueue } from '../../jobs/queue.js';
import { getDoujinProvider } from '../../downloader/providers.js';
import { rewriteDoujinCover } from '../media.js';
import { addWatchedSearch, listNewGalleries, listWatchedSearches, removeWatchedSearch, listGalleryFeed, setGalleriesReviewed } from '../../services/watchedSearches.js';
import { type DoujinSource } from '../../downloader/types.js';

import { intParam } from './helpers.js';
export const api = new Hono();
api.get('/watched-searches', (c) => c.json(listWatchedSearches()));

api.get('/watched-searches/feed', (c) => {
  const view = c.req.query('view') ?? 'inbox', source = c.req.query('source'), watch = c.req.query('searchId');
  const offset = Number(c.req.query('offset') ?? 0), limit = Number(c.req.query('limit') ?? 25);
  if (!['inbox', 'history'].includes(view) || (source && source !== 'hitomi' && source !== 'nhentai') || (watch !== undefined && (!Number.isSafeInteger(Number(watch)) || Number(watch) < 1)) || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) return c.json({ error: 'Invalid feed filters or page.' }, 400);
  const feed = listGalleryFeed({ view: view as 'inbox' | 'history', source, searchId: watch ? Number(watch) : undefined, offset, limit });
  return c.json({ ...feed, items: feed.items.map(rewriteDoujinCover) });
});

api.post('/watched-searches/review', async (c) => {
  const body = await c.req.json().catch(() => null) as { items?: { source: DoujinSource; galleryId: string }[]; reviewed?: boolean } | null;
  if (!body || typeof body.reviewed !== 'boolean' || !Array.isArray(body.items) || !body.items.length || body.items.length > 100 || body.items.some(item => !item || !['hitomi', 'nhentai'].includes(item.source) || typeof item.galleryId !== 'string' || !item.galleryId.trim())) return c.json({ error: 'Provide 1–100 galleries and a reviewed state.' }, 400);
  if (!setGalleriesReviewed(body.items, body.reviewed)) return c.json({ error: 'Discovery not found. Refresh the feed and try again.' }, 404);
  return c.json({ ok: true });
});

/** Newest-first feed of galleries the watches reported as new ("Recently added"). */
api.get('/watched-searches/new', (c) => {
  const limitParam = Number(c.req.query('limit') ?? '100');
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(Math.floor(limitParam), 500) : 100;
  // Hitomi covers need the /media proxy (their CDN requires a Referer the browser can't send).
  return c.json(listNewGalleries(limit).map(rewriteDoujinCover));
});

api.post('/watched-searches', async (c) => {
  const body = (await c.req.json()) as { source?: string; query?: string };
  if (!body.source || !getDoujinProvider(body.source)) return c.json({ error: `Unknown source: ${body.source ?? ''}` }, 400);
  const query = body.query?.trim();
  if (!query) return c.json({ error: 'query is required' }, 400);
  const added = addWatchedSearch(body.source as DoujinSource, query);
  return c.json(added, 201);
});

api.delete('/watched-searches/:id', (c) => {
  const id = intParam(c.req.param('id'));
  if (id === null) return c.json({ error: 'Invalid watched search id' }, 400);
  const removed = removeWatchedSearch(id);
  if (!removed) return c.json({ error: 'Watched search not found' }, 404);
  return c.json({ ok: true });
});

api.post('/watched-searches/check', (c) => {
  const active = jobQueue.active().find((job) => job.type === 'check-watched-searches');
  if (active) return c.json({ id: active.id, alreadyRunning: true }, 202);
  const id = jobQueue.enqueue('check-watched-searches', {});
  return c.json({ id, alreadyRunning: false }, 202);
});

api.get('/watched-searches/check-status', (c) => c.json(jobQueue.active().find(job => job.type === 'check-watched-searches') ?? jobQueue.latest('check-watched-searches')));
