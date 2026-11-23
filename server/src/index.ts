import { serve } from '@hono/node-server';
import { initDb } from './db/index.js';
import { createApp } from './app.js';
import { jobQueue } from './jobs/queue.js';
import { runJob } from './jobs/executor.js';
import { getCredentialMap, getKavitaConnection, getPollIntervalHours, onSettingChange } from './services/settings.js';
import { backfillNewGalleries, initializeWatchedSchedule, rescheduleWatchedSearches, dueWatchedSearchIds } from './services/watchedSearches.js';
import { downloadQueue } from './downloader/engine.js';
import { startRecommendationPreloading } from './services/recommendations.js';
import { prefetchMedia } from './routes/media.js';
import { interruptMetadataHistory } from './services/metadataHistory.js';
import { interruptMetadataRestore } from './services/metadataRestore.js';

const PORT = Number(process.env.PORT ?? 8787);
// Local-only by default. Set HOST=0.0.0.0 deliberately for remote access;
// the login gate protects the HTTP surface in either mode.
const HOST = process.env.HOST ?? '127.0.0.1';

/** Epoch ms of a job's createdAt (SQLite UTC 'YYYY-MM-DD HH:MM:SS' or ISO), 0 when absent/invalid. */
function jobCreatedAtMs(createdAt: string | undefined): number {
  if (!createdAt) return 0;
  const ms = Date.parse(createdAt.includes('T') ? createdAt : createdAt.replace(' ', 'T') + 'Z');
  return Number.isFinite(ms) ? ms : 0;
}

function main(): void {
  initDb();
  interruptMetadataHistory();
  // Replay "new since last check" finds that older builds never persisted to the
  // "recently added" feed (no-op on databases already up to date).
  const backfilled = backfillNewGalleries();
  if (backfilled > 0) console.log(`[h-tosho] migrated ${backfilled} pre-existing watch find(s) into the recently added feed`);
  // Orphaned 'running' jobs become failed; interrupted merges release their
  // downloads before the download queue restarts them.
  jobQueue.interruptRunningJobs();
  interruptMetadataRestore();
  jobQueue.registerHandler(runJob);
  downloadQueue.start();

  // Discovery is independent of the auto-apply scan. Catch up once at startup,
  // then check daily, including installations that disable automatic matching.
  const scanMatchableIfDue = () => {
    const connection = getKavitaConnection();
    if (!connection.baseUrl || !connection.apiKey || !getCredentialMap().enabledProviders.length) return;
    if (jobQueue.active().some(job => job.type === 'scan-matchable')) return;
    const lastAttempt = jobCreatedAtMs(jobQueue.latest('scan-matchable')?.createdAt);
    if (!lastAttempt || Date.now() - lastAttempt >= 86_400_000) jobQueue.enqueue('scan-matchable', {});
  };
  scanMatchableIfDue();
  const matchableTimer = setInterval(scanMatchableIfDue, 60_000);
  matchableTimer.unref();

// Watched doujin searches run on a configurable cadence independent of the
// series scan interval, so release detection stays responsive at long scan intervals.
  // The deadline counts from the last scan-new job, not from process start,
  // so frequent restarts (e.g. automatic updates) cannot postpone it forever.
  let pollTimer: NodeJS.Timeout | undefined;
  function scheduleScan(): void {
    clearTimeout(pollTimer);
    const intervalHours = getPollIntervalHours();
    if (intervalHours > 0) {
      const intervalMs = intervalHours * 3_600_000;
      const lastScan = jobCreatedAtMs(jobQueue.latest('scan-new')?.createdAt);
      const delay = lastScan ? Math.min(intervalMs, Math.max(0, lastScan + intervalMs - Date.now())) : intervalMs;
      pollTimer = setTimeout(async () => {
        const conn = getKavitaConnection();
        if (conn.baseUrl && conn.apiKey) {
          const active = jobQueue.active().some((j) => j.type === 'scan-new');
          if (!active) jobQueue.enqueue('scan-new', {});
        }
        scheduleScan();
      }, delay);
      pollTimer.unref?.();
    }
  }

  initializeWatchedSchedule();
  function sweepWatchedSearches(): void {
    if (jobQueue.active().some(job => job.type === 'check-watched-searches')) return;
    const watchIds = dueWatchedSearchIds();
    if (watchIds.length) jobQueue.enqueue('check-watched-searches', { mode: 'due', watchIds });
  }
  const watchedTimer = setInterval(sweepWatchedSearches, 15_000);
  watchedTimer.unref();
  const unsubscribePollInterval = onSettingChange('poll-interval', scheduleScan);
  const unsubscribeWatchedSearchInterval = onSettingChange('watched-search-interval', () => {
    rescheduleWatchedSearches();
    sweepWatchedSearches();
  });
  const unsubscribeDownloaderSettings = onSettingChange('downloader', () => {
    downloadQueue.onSettingsChanged();
  });
  scheduleScan();
  sweepWatchedSearches();
  const app = createApp();
  const server = serve({ fetch: app.fetch, port: PORT, hostname: HOST });
  console.log(`[h-tosho] listening on http://${HOST}:${PORT} (api at /api)`);
  const stopRecommendationPreloading = startRecommendationPreloading(prefetchMedia);

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('[h-tosho] shutting down');
    unsubscribePollInterval();
    unsubscribeWatchedSearchInterval();
    unsubscribeDownloaderSettings();
    clearTimeout(pollTimer);
    clearInterval(watchedTimer);
    clearInterval(matchableTimer);
    stopRecommendationPreloading();
    void downloadQueue.shutdown(1500).finally(() => {
      server.close(() => process.exit(0));
    });
    setTimeout(() => process.exit(0), 2500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
