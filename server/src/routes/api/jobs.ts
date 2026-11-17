import { parseJobCommand } from '../../contracts/jobs.js';
import { prepareDuplicateCheck, findDuplicateReports } from '../../services/galleryDuplicates.js';
import { Hono } from 'hono';
import { desc } from 'drizzle-orm';
import { getDb, schema } from '../../db/index.js';
import { jobQueue, type JobPayload } from '../../jobs/queue.js';
import { validateMergeDownloads } from '../../jobs/mergeDownloads.js';

import { resolveJobContext, errMsg, intParam } from './helpers.js';
export const api = new Hono();
api.post('/jobs', async (c) => {
  const body = await c.req.json();
  let command;
  try { command = parseJobCommand(body?.type, body); validateMergeDownloads('downloads' in command.payload ? command.payload.downloads : undefined); }
  catch (error) { return c.json({ error: errMsg(error) }, 400); }
  if (command.type === 'restore-metadata') return c.json({ error: 'Restore requires a reviewed metadata preview; use the series restore action' }, 409);
  if (command.type === 'check-watched-searches') return c.json({ error: 'Use the Following check action; scheduled checks are selected by the server' }, 409);
  const payload: JobPayload = command.payload;
  if (body.type === 'merge-series' && payload.downloads?.length) {
    try {
      const identities = await prepareDuplicateCheck(payload.downloads);
      const check = findDuplicateReports(identities, payload.sourceFiles);
      if (check.reports.some(report => report.matches.length && !payload.downloads!.find(plan => plan.source === report.source && plan.galleryId === report.galleryId)?.allowDuplicate)) return c.json({ error: 'possible-duplicate', ...check }, 409);
    } catch (error) { return c.json({ error: 'Could not check for duplicates', message: errMsg(error) }, 502); }
  }
  payload.context = await resolveJobContext(payload);
  const id = jobQueue.enqueueCommand(command, { context: payload.context, contextPendingSeriesIds: payload.contextPendingSeriesIds });
  return c.json({ id }, 202);
});

api.get('/jobs', (c) => c.json(jobQueue.list(100)));

api.delete('/jobs/failed', (c) => c.json({ removed: jobQueue.clearFailed() }));

api.delete('/jobs/:id', (c) => {
  const id = intParam(c.req.param('id'));
  if (id === null || id <= 0) return c.json({ error: 'Invalid job id' }, 400);
  if (!jobQueue.get(id)) return c.json({ error: 'Job not found' }, 404);
  const removed = jobQueue.clearFailed(id);
  if (!removed) return c.json({ error: 'Only failed jobs can be cleared' }, 409);
  return c.json({ removed });
});

api.get('/jobs/:id', (c) => {
  const id = intParam(c.req.param('id'));
  if (id === null) return c.json({ error: 'Invalid job id' }, 400);
  const job = jobQueue.get(id);
  if (!job) return c.json({ error: 'Job not found' }, 404);
  return c.json({ job, logs: jobQueue.logs(job.id) });
});

api.post('/jobs/:id/cancel', (c) => {
  const id = intParam(c.req.param('id'));
  if (id === null) return c.json({ error: 'Invalid job id' }, 400);
  if (!jobQueue.cancel(id)) return c.json({ error: 'Job is not active' }, 409);
  return c.json({ ok: true });
});

api.post('/jobs/:id/retry', (c) => {
  const id = intParam(c.req.param('id'));
  if (id === null) return c.json({ error: 'Invalid job id' }, 400);
  const newId = jobQueue.retryJob(id);
  if (newId === null) return c.json({ error: 'Job is not retryable' }, 409);
  return c.json({ ok: true, id: newId });
});

api.get('/logs', (c) => c.json(jobQueue.recentLogs(300)));

api.get('/history', (c) => {
  const rows = getDb().select().from(schema.syncHistory).orderBy(desc(schema.syncHistory.id)).limit(200).all();
  return c.json(
    rows.map((r) => ({
      id: r.id,
      kavitaSeriesId: r.kavitaSeriesId,
      seriesTitle: r.seriesTitle,
      action: r.action,
      details: r.detailsJson,
      createdAt: r.createdAt })),
  );
});
