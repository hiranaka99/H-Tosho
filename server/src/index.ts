import { serve } from '@hono/node-server';
import { eq } from 'drizzle-orm';
import { getDb, initDb, schema } from './db/index.js';
import { createApp } from './app.js';
import { jobQueue } from './jobs/queue.js';
import { runJob } from './jobs/executor.js';
import { getKavitaConnection, getPollInterval } from './services/settings.js';
import { countWatchedSearches } from './services/watchedSearches.js';

const PORT = Number(process.env.PORT ?? 8787);
// Local-only by default: the API has no per-user auth, so binding to all
// interfaces exposes it to the whole LAN. Set HOST=0.0.0.0 (plus HTOSHO_TOKEN)
// deliberately when remote access is needed.
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

  let pollTimer: NodeJS.Timeout | null = null;
  function scheduleScan(): void {
    if (pollTimer) clearTimeout(pollTimer);
    const interval = getPollInterval();
    if (interval > 0) {
      pollTimer = setTimeout(async () => {
        const conn = getKavitaConnection();
        if (conn.baseUrl && conn.apiKey) {
          const active = jobQueue.active().some((j) => j.type === 'scan-new');
          if (!active) jobQueue.enqueue('scan-new', {});
        }
        // Watched doujin searches run on the same cadence; they need no Kavita.
        if (countWatchedSearches() > 0 && !jobQueue.active().some((j) => j.type === 'check-watched-searches')) {
          jobQueue.enqueue('check-watched-searches', {});
        }
        scheduleScan();
      }, interval * 60_000);
      pollTimer.unref?.();
    }
  }
  scheduleScan();

  const app = createApp();
  const server = serve({ fetch: app.fetch, port: PORT, hostname: HOST });
  console.log(`[h-tosho] listening on http://${HOST}:${PORT} (api at /api)`);
  if (HOST === '0.0.0.0' || HOST === '::') {
    console.warn('[h-tosho] WARNING: bound to all network interfaces. Set HTOSHO_TOKEN to protect the API, or keep the default HOST=127.0.0.1 for local-only use.');
  }

  const shutdown = (): void => {
    console.log('[h-tosho] shutting down');
    if (pollTimer) clearTimeout(pollTimer);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();