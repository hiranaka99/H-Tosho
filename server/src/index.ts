import { serve } from '@hono/node-server';
import { initDb } from './db/index.js';
import { createApp } from './app.js';
import { jobQueue } from './jobs/queue.js';
import { runJob } from './jobs/executor.js';
import { getKavitaConnection, getPollInterval } from './services/settings.js';

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '0.0.0.0';

function main(): void {
  initDb();
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
        scheduleScan();
      }, interval * 60_000);
      pollTimer.unref?.();
    }
  }
  scheduleScan();

  const app = createApp();
  const server = serve({ fetch: app.fetch, port: PORT, hostname: HOST });
  console.log(`[h-tosho] listening on http://${HOST}:${PORT} (api at /api)`);

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