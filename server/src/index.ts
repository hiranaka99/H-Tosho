import { serve } from '@hono/node-server';
import { eq } from 'drizzle-orm';
import { getDb, initDb, schema } from './db/index.js';
import { createApp } from './app.js';
import { jobQueue } from './jobs/queue.js';
import { runJob } from './jobs/executor.js';
import { getCredentialMap, getKavitaConnection, getPollIntervalHours, getWatchedSearchIntervalMinutes, onSettingChange } from './services/settings.js';
import { backfillNewGalleries, countWatchedSearches } from './services/watchedSearches.js';
import { downloadQueue } from './downloader/engine.js';

const PORT = Number(process.env.PORT ?? 8787);
// Local-only by default. Set HOST=0.0.0.0 deliberately for remote access;
// the login gate protects the HTTP surface in either mode.
const HOST = process.env.HOST ?? '127.0.0.1';

function main(): void {
  initDb();
  // Replay "new since last check" finds that older builds never persisted to the
  // "recently added" feed (no-op on databases already up to date).
  const backfilled = backfillNewGalleries();
  if (backfilled > 0) console.log(`[h-tosho] migrated ${backfilled} pre-existing watch find(s) into the recently added feed`);
  // Jobs still marked 'running' were orphaned by a crash or restart (no process
  // is executing them). Mark them failed so the UI doesn't show ghosts that can
  // never be cancelled or completed.
  getDb()
    .update(schema.jobs)
    .set({ status: 'failed', errorMessage: 'Interrupted by server restart', finishedAt: new Date().toISOString() })
    .where(eq(schema.jobs.status, 'running'))
    .run();
  jobQueue.registerHandler(runJob);
  downloadQueue.start();

  // Discovery is independent of the auto-apply scan. Catch up once at startup,
  // then check daily, including installations that disable automatic matching.
  const scanMatchableIfDue = () => {
    const connection = getKavitaConnection();
    if (!connection.baseUrl || !connection.apiKey || !getCredentialMap().enabledProviders.length) return;
    if (jobQueue.active().some(job => job.type === 'scan-matchable')) return;
    const latest = jobQueue.latest('scan-matchable');
    const createdAt = latest?.createdAt;
    const lastAttempt = createdAt ? Date.parse(createdAt.includes('T') ? createdAt : createdAt.replace(' ', 'T') + 'Z') : 0;
    if (!lastAttempt || Date.now() - lastAttempt >= 86_400_000) jobQueue.enqueue('scan-matchable', {});
  };
  scanMatchableIfDue();
  const matchableTimer = setInterval(scanMatchableIfDue, 60_000);
  matchableTimer.unref();

// Watched doujin searches run on a configurable cadence independent of the
// series scan interval, so release detection stays responsive at long scan intervals.
  let pollTimer: NodeJS.Timeout | undefined;
  function scheduleScan(): void {
    clearTimeout(pollTimer);
    const intervalHours = getPollIntervalHours();
    if (intervalHours > 0) {
      pollTimer = setTimeout(async () => {
        const conn = getKavitaConnection();
        if (conn.baseUrl && conn.apiKey) {
          const active = jobQueue.active().some((j) => j.type === 'scan-new');
          if (!active) jobQueue.enqueue('scan-new', {});
        }
        scheduleScan();
      }, intervalHours * 3_600_000);
      pollTimer.unref?.();
    }
  }

  let watchedTimer: NodeJS.Timeout | undefined;
  function scheduleWatchedSearches(): void {
    clearTimeout(watchedTimer);
    const intervalMinutes = getWatchedSearchIntervalMinutes();
    if (intervalMinutes > 0) {
      watchedTimer = setTimeout(async () => {
        if (countWatchedSearches() > 0 && !jobQueue.active().some((j) => j.type === 'check-watched-searches')) {
          jobQueue.enqueue('check-watched-searches', {});
        }
        scheduleWatchedSearches();
      }, intervalMinutes * 60_000);
      watchedTimer.unref?.();
    }
  }

  const unsubscribePollInterval = onSettingChange('poll-interval', scheduleScan);
  const unsubscribeWatchedSearchInterval = onSettingChange('watched-search-interval', scheduleWatchedSearches);
  scheduleScan();
  scheduleWatchedSearches();
  const app = createApp();
  const server = serve({ fetch: app.fetch, port: PORT, hostname: HOST });
  console.log(`[h-tosho] listening on http://${HOST}:${PORT} (api at /api)`);

  const shutdown = (): void => {
    console.log('[h-tosho] shutting down');
    unsubscribePollInterval();
    unsubscribeWatchedSearchInterval();
    clearTimeout(pollTimer);
    clearTimeout(watchedTimer);
    clearInterval(matchableTimer);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
