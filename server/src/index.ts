import { serve } from '@hono/node-server';
import { eq } from 'drizzle-orm';
import { getDb, initDb, schema } from './db/index.js';
import { createApp } from './app.js';
import { jobQueue } from './jobs/queue.js';
import { runJob } from './jobs/executor.js';
import { getKavitaConnection, getPollIntervalHours } from './services/settings.js';
import { countWatchedSearches } from './services/watchedSearches.js';
import { downloadQueue } from './downloader/engine.js';

const PORT = Number(process.env.PORT ?? 8787);
// Local-only by default: the API has no auth, so binding to all interfaces
// exposes it to the whole LAN. Set HOST=0.0.0.0 deliberately when remote
// access is needed.
const HOST = process.env.HOST ?? '127.0.0.1';

function main(): void {
  initDb();
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

// Watched doujin searches run on a fixed cadence independent of the series
// scan interval, so release detection stays responsive at long scan intervals.
const WATCHED_SEARCH_INTERVAL_MS = 15 * 60_000;

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
    watchedTimer = setTimeout(async () => {
      if (countWatchedSearches() > 0 && !jobQueue.active().some((j) => j.type === 'check-watched-searches')) {
        jobQueue.enqueue('check-watched-searches', {});
      }
      scheduleWatchedSearches();
    }, WATCHED_SEARCH_INTERVAL_MS);
    watchedTimer.unref?.();
  }
  scheduleScan();
  scheduleWatchedSearches();

  const app = createApp();
  const server = serve({ fetch: app.fetch, port: PORT, hostname: HOST });
  console.log(`[h-tosho] listening on http://${HOST}:${PORT} (api at /api)`);
  if (HOST === '0.0.0.0' || HOST === '::') {
    console.warn('[h-tosho] WARNING: bound to all network interfaces and the API has no auth — keep the default HOST=127.0.0.1 unless you accept LAN exposure.');
  }

  const shutdown = (): void => {
    console.log('[h-tosho] shutting down');
    clearTimeout(pollTimer);
    clearTimeout(watchedTimer);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();