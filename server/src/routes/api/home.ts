import { Hono } from 'hono';
import { desc, eq } from 'drizzle-orm';
import { getDb, schema } from '../../db/index.js';
import { jobQueue } from '../../jobs/queue.js';
import { listMatchSuggestions, rejectMatchCandidate } from '../../services/matchSuggestions.js';
import { connectedClient, intParam, kavitaCoverUrl } from './helpers.js';
import { rewriteMangaDexCoverUrl } from '../media.js';

export const api = new Hono();

api.get('/home/matches', c => {
  const items = listMatchSuggestions().map(item => ({ ...item,
    cover: item.cover ? kavitaCoverUrl(item.seriesId, item.cover) : null,
    candidate: { ...item.candidate, coverUrl: rewriteMangaDexCoverUrl(item.candidate.coverUrl) },
  }));
  return c.json({ items, configured: !!connectedClient(), scan: jobQueue.active().find(job => job.type === 'scan-matchable') ?? jobQueue.latest('scan-matchable') });
});

api.post('/home/matches/scan', c => {
  if (!connectedClient()) return c.json({ error: 'Connect Kavita before scanning for matches.' }, 503);
  const active = jobQueue.active().find(job => job.type === 'scan-matchable');
  return c.json({ id: active?.id ?? jobQueue.enqueue('scan-matchable', {}), alreadyRunning: !!active }, 202);
});

api.post('/home/matches/:id/reject', async c => {
  const id = intParam(c.req.param('id'));
  const body = await c.req.json().catch(() => null);
  if (id === null || !body || typeof body.providerId !== 'string' || typeof body.providerSeriesId !== 'string' || !body.providerId.trim() || !body.providerSeriesId.trim()) return c.json({ error: 'Provide a series and provider candidate.' }, 400);
  if (!rejectMatchCandidate(id, body.providerId, body.providerSeriesId)) return c.json({ error: 'This candidate changed. Refresh and try again.' }, 409);
  return c.json({ ok: true });
});

api.get('/home/activity', c => {
  const db = getDb();
  const history = db.select().from(schema.syncHistory).orderBy(desc(schema.syncHistory.id)).limit(20).all().map(row => ({
    id: `series-${row.id}`, title: row.seriesTitle || `Series #${row.kavitaSeriesId}`, action: row.action,
    createdAt: row.createdAt, href: `/libraries?series=${row.kavitaSeriesId}`,
  }));
  const downloads = db.select().from(schema.downloadQueue).where(eq(schema.downloadQueue.status, 'completed')).orderBy(desc(schema.downloadQueue.finishedAt)).limit(20).all().map(row => ({
    id: `download-${row.id}`, title: row.title || `Gallery #${row.galleryId}`, action: 'downloaded',
    createdAt: row.finishedAt ?? row.createdAt, href: '/downloader?tab=downloads',
  }));
  const timestamp = (value: string) => Date.parse(value.includes('T') ? value : value.replace(' ', 'T') + 'Z');
  return c.json([...history, ...downloads].sort((a, b) => timestamp(b.createdAt) - timestamp(a.createdAt) || b.id.localeCompare(a.id)).slice(0, 12));
});
