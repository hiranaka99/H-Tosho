import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { RESTART_EXIT_CODE } from './bootstrap.js';
import { appUpdateManager } from './services/appUpdate.js';
import { closeDb, initDb, startDatabaseMaintenance } from './db/index.js';
import { createApp } from './app.js';
import { jobQueue } from './jobs/queue.js';
import { runJob } from './jobs/executor.js';
import { getCredentialMap, getKavitaConnection, getMatchRefreshIntervalDays, getPollIntervalHours, onSettingChange } from './services/settings.js';
import { backfillNewGalleries, initializeWatchedSchedule, rescheduleWatchedSearches, dueWatchedSearchIds, nextWatchedSearchDueAt, onWatchedScheduleChange } from './services/watchedSearches.js';
import { downloadQueue } from './downloader/engine.js';
import { startRecommendationPreloading } from './services/recommendations.js';
import { prefetchMedia } from './routes/media.js';
import { interruptMetadataHistory } from './services/metadataHistory.js';
import { interruptMetadataRestore } from './services/metadataRestore.js';
import { closeDownloadEventStreams } from './routes/api/downloads.js';

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
  // initDb applied the retention windows once; keep applying them daily.
  const stopDatabaseMaintenance = startDatabaseMaintenance();
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
    if (jobQueue.hasActiveType('scan-matchable')) return;
    const lastAttempt = jobCreatedAtMs(jobQueue.latestCreatedAt('scan-matchable') ?? undefined);
    if (!lastAttempt || Date.now() - lastAttempt >= 86_400_000) jobQueue.enqueue('scan-matchable', {});
  };
  // Matched series are re-read from their exact provider candidate on their own
  // cadence. Only changes to that candidate surface; nothing is searched or applied.
  const refreshMatchedIfDue = () => {
    const days = getMatchRefreshIntervalDays();
    const connection = getKavitaConnection();
    if (days <= 0 || !connection.baseUrl || !connection.apiKey || !getCredentialMap().enabledProviders.length) return;
    if (jobQueue.hasActiveType('refresh-matched')) return;
    const lastAttempt = jobCreatedAtMs(jobQueue.latestCreatedAt('refresh-matched') ?? undefined);
    if (!lastAttempt || Date.now() - lastAttempt >= days * 86_400_000) jobQueue.enqueue('refresh-matched', {});
  };
  scanMatchableIfDue();
  refreshMatchedIfDue();
  const matchableTimer = setInterval(() => { scanMatchableIfDue(); refreshMatchedIfDue(); }, 60_000);
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
      const lastScan = jobCreatedAtMs(jobQueue.latestCreatedAt('scan-new') ?? undefined);
      const delay = lastScan ? Math.min(intervalMs, Math.max(0, lastScan + intervalMs - Date.now())) : intervalMs;
      pollTimer = setTimeout(async () => {
        const conn = getKavitaConnection();
        if (conn.baseUrl && conn.apiKey) {
          if (!jobQueue.hasActiveType('scan-new')) jobQueue.enqueue('scan-new', {});
        }
        scheduleScan();
      }, delay);
      pollTimer.unref?.();
    }
  }

  let shuttingDown = false;
  initializeWatchedSchedule();
  let watchedTimer: NodeJS.Timeout | undefined;
  function scheduleWatchedSweep(): void {
    clearTimeout(watchedTimer);
    watchedTimer = undefined;
    if (shuttingDown || jobQueue.hasActiveType('check-watched-searches')) return;
    const watchIds = dueWatchedSearchIds();
    if (watchIds.length) {
      jobQueue.enqueue('check-watched-searches', { mode: 'due', watchIds });
      return;
    }
    const nextDue = nextWatchedSearchDueAt();
    if (nextDue !== null) {
      const delay = Math.min(300_000, Math.max(250, nextDue - Date.now()));
      watchedTimer = setTimeout(scheduleWatchedSweep, delay);
      watchedTimer.unref();
    }
  }
  const unsubscribeWatchedSchedule = onWatchedScheduleChange(scheduleWatchedSweep);
  const unsubscribeWatchedJob = jobQueue.onSettled((ev) => {
    if (ev.type === 'check-watched-searches') scheduleWatchedSweep();
  });
  const unsubscribePollInterval = onSettingChange('poll-interval', scheduleScan);
  const unsubscribeWatchedSearchInterval = onSettingChange('watched-search-interval', () => {
    rescheduleWatchedSearches();
    scheduleWatchedSweep();
  });
  const unsubscribeDownloaderSettings = onSettingChange('downloader', () => {
    downloadQueue.onSettingsChanged();
  });
  scheduleScan();
  scheduleWatchedSweep();
  const app = createApp();
  const server = serve({ fetch: app.fetch, port: PORT, hostname: HOST });
  console.log(`[h-tosho] listening on http://${HOST}:${PORT} (api at /api)`);
  const stopRecommendationPreloading = startRecommendationPreloading(prefetchMedia);

  const shutdown = (mode: 'stop' | 'restart' = 'stop'): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(mode === 'restart' ? '[h-tosho] restarting for update' : '[h-tosho] shutting down');
    unsubscribePollInterval();
    unsubscribeWatchedSearchInterval();
    unsubscribeWatchedSchedule();
    unsubscribeWatchedJob();
    unsubscribeDownloaderSettings();
    clearTimeout(pollTimer);
    clearTimeout(watchedTimer);
    clearInterval(matchableTimer);
    stopRecommendationPreloading();
    stopDatabaseMaintenance();
    let exited = false;
    const exit = (): void => {
      if (exited) return;
      exited = true;
      // Close SQLite last so the WAL is checkpointed and no write is cut short.
      try { closeDb(); } catch (error) { console.warn('[h-tosho] could not close the database cleanly:', error); }
      if (mode === 'restart') {
        if (process.env.HTOSHO_BOOTSTRAPPED === '1') {
          process.exit(RESTART_EXIT_CODE);
        }
        const externallySupervised = Boolean(process.env.INVOCATION_ID || process.env.pm_id || process.env.HTOSHO_SUPERVISED === '1');
        if (!externallySupervised) {
          const entryDir = path.dirname(fileURLToPath(import.meta.url));
          const appRoot = process.env.HTOSHO_APP_ROOT ?? path.resolve(entryDir, '..', '..');
          const nextEntry = path.join(appRoot, 'server', 'dist', 'index.js');
          try {
            const child = spawn(process.execPath, [nextEntry], {
              cwd: appRoot,
              env: process.env,
              detached: true,
              stdio: 'ignore',
            });
            child.unref();
          } catch (error) {
            console.error('[h-tosho] failed to spawn restarted server process:', error);
          }
        }
      }
      process.exit(0);
    };
    void downloadQueue.shutdown(1500).finally(() => {
      // Live SSE streams would otherwise hold server.close() open until the
      // forced exit below.
      closeDownloadEventStreams();
      server.close(exit);
      (server as { closeIdleConnections?: () => void }).closeIdleConnections?.();
    });
    setTimeout(exit, 2500).unref();
  };
  appUpdateManager.registerRestartHandler(() => shutdown('restart'));
  process.on('SIGINT', () => shutdown('stop'));
  process.on('SIGTERM', () => shutdown('stop'));
}

main();
