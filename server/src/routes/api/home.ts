import { Hono } from 'hono';
import { desc, eq } from 'drizzle-orm';
import { getDb, schema } from '../../db/index.js';
import { jobQueue } from '../../jobs/queue.js';
import { listMatchSuggestions, rejectMatchCandidate, restoreMatchCandidate } from '../../services/matchSuggestions.js';
import { dismissMatchUpdate, listMatchUpdates } from '../../services/matchRefresh.js';
import { connectedClient, intParam, kavitaCoverUrl } from './helpers.js';
import { rewriteMangaDexCoverUrl } from '../media.js';

export const api = new Hono();

/** The first recorded error of a failed sync, so Home can say why without opening the series. */
function firstHistoryError(detailsJson: string | null): string | null {
  if (!detailsJson) return null;
  try {
    const errors = (JSON.parse(detailsJson) as { errors?: unknown }).errors;
    const first = Array.isArray(errors) ? errors.find(error => typeof error === 'string' && error.trim()) : undefined;
    return typeof first === 'string' ? first.trim() : null;
  } catch { return null; }
}

api.get('/home/matches', c => {
  const items = listMatchSuggestions().map(item => ({ ...item,
    cover: item.cover ? kavitaCoverUrl(item.seriesId, item.cover) : null,
    candidate: { ...item.candidate, coverUrl: rewriteMangaDexCoverUrl(item.candidate.coverUrl) },
  }));
  const latest = [jobQueue.latest('scan-matchable'), jobQueue.latest('scan-downloaded')].filter(job => !!job).sort((a, b) => b.id - a.id)[0];
  return c.json({ items, configured: !!connectedClient(), scan: jobQueue.active().find(job => job.type === 'scan-matchable' || job.type === 'scan-downloaded') ?? latest });
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

api.delete('/home/matches/:id/reject', async c => {
  const id = intParam(c.req.param('id'));
  const body = await c.req.json().catch(() => null);
  if (id === null || !body || typeof body.providerId !== 'string' || typeof body.providerSeriesId !== 'string' || !body.providerId.trim() || !body.providerSeriesId.trim()) return c.json({ error: 'Provide a series and provider candidate.' }, 400);
  restoreMatchCandidate(id, body.providerId, body.providerSeriesId);
  return c.json({ ok: true });
});

/** Provider changes to the exact candidate each series is matched to. */
api.get('/home/updates', c => {
  const items = listMatchUpdates().map(item => ({ ...item,
    cover: item.cover ? kavitaCoverUrl(item.seriesId, item.cover) : null,
    candidateCoverUrl: rewriteMangaDexCoverUrl(item.candidateCoverUrl ?? undefined) ?? null,
  }));
  return c.json({ items, configured: !!connectedClient(), refresh: jobQueue.active().find(job => job.type === 'refresh-matched') ?? jobQueue.latest('refresh-matched') ?? null });
});

api.post('/home/updates/refresh', c => {
  if (!connectedClient()) return c.json({ error: 'Connect Kavita before checking for updates.' }, 503);
  const active = jobQueue.active().find(job => job.type === 'refresh-matched');
  return c.json({ id: active?.id ?? jobQueue.enqueue('refresh-matched', {}), alreadyRunning: !!active }, 202);
});

for (const [method, dismissed] of [['post', true], ['delete', false]] as const) {
  api[method]('/home/updates/:id/dismiss', c => {
    const id = intParam(c.req.param('id'));
    if (id === null) return c.json({ error: 'Invalid series id' }, 400);
    if (!dismissMatchUpdate(id, dismissed)) return c.json({ error: 'This update is no longer waiting. Refresh Home.' }, 404);
    return c.json({ ok: true });
  });
}

api.get('/home/activity', c => {
  const db = getDb();
  const history = db.select({
    id: schema.syncHistory.id,
    kavitaSeriesId: schema.syncHistory.kavitaSeriesId,
    seriesTitle: schema.syncHistory.seriesTitle,
    action: schema.syncHistory.action,
    createdAt: schema.syncHistory.createdAt,
    detailsJson: schema.syncHistory.detailsJson,
  }).from(schema.syncHistory).orderBy(desc(schema.syncHistory.id)).limit(20).all().map(row => ({
    id: `series-${row.id}`, title: row.seriesTitle || `Series #${row.kavitaSeriesId}`, action: row.action,
    createdAt: row.createdAt, href: `/libraries?series=${row.kavitaSeriesId}`,
    ...(row.action === 'failed' ? { detail: firstHistoryError(row.detailsJson) } : {}),
  }));
  const downloads = db.select({
    id: schema.downloadQueue.id,
    galleryId: schema.downloadQueue.galleryId,
    title: schema.downloadQueue.title,
    finishedAt: schema.downloadQueue.finishedAt,
    createdAt: schema.downloadQueue.createdAt,
  }).from(schema.downloadQueue).where(eq(schema.downloadQueue.status, 'completed')).orderBy(desc(schema.downloadQueue.finishedAt)).limit(20).all().map(row => ({
    id: `download-${row.id}`, title: row.title || `Gallery #${row.galleryId}`, action: 'downloaded',
    createdAt: row.finishedAt ?? row.createdAt, href: '/downloader?tab=downloads',
  }));
  const timestamp = (value: string) => Date.parse(value.includes('T') ? value : value.replace(' ', 'T') + 'Z');
  return c.json([...history, ...downloads].sort((a, b) => timestamp(b.createdAt) - timestamp(a.createdAt) || b.id.localeCompare(a.id)).slice(0, 12));
});
