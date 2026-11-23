import fs from 'node:fs';
import path from 'node:path';
import type { DoujinGallery } from './types.js';
import type { DownloaderSettings } from '../services/settings.js';
import { sleep } from '../lib/http.js';
import { extFromUrl, padPage } from './util.js';
import {
  errorRetryAfterMs,
  fetchPageToFileWithRetry,
  isRouteRefreshableError,
  isTransientError,
  jitterDelay,
  resolvePageCandidates,
} from './requests.js';
import { DownloadPausedError, DownloadShutdownError, wakePaused, type RunContext, type LiveFields } from './runtime.js';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 H-Tosho/1.0';
export async function downloadPages(
  gallery: DoujinGallery,
  taskId: number,
  settings: DownloaderSettings,
  ctx: RunContext,
  tmpDir: string,
  updateProgress: (id: number, patch: LiveFields, options?: { force?: boolean; forceBroadcast?: boolean }) => void,
): Promise<{ name: string; path: string }[]> {
  const pages = gallery.pages;
  const total = pages.length;
  const concurrency = Math.max(1, settings.maxImageConcurrency || 1);
  const delay = Math.max(0, settings.requestDelayMs || 0);
  const pageHeaders: Record<string, string> = { 'User-Agent': UA, ...gallery.requestHeaders };
  await fs.promises.mkdir(tmpDir, { recursive: true });
  const out: { name: string; path: string }[] = new Array(total);

  // Real page names (with the extension of the *downloaded* image) persist in
  // a sidecar so a resumed run never re-derives names from the static page
  // reference — E-Hentai viewer URLs end in .jpg even when the H@H image they
  // resolve to is a different format.
  const namesPath = path.join(tmpDir, 'page-names.json');
  const readNames = async (): Promise<Record<string, string>> => {
    try {
      const parsed: unknown = JSON.parse(await fs.promises.readFile(namesPath, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const names: Record<string, string> = {};
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof value === 'string' && value.length > 0) names[key] = value;
        }
        return names;
      }
    } catch {
      /* no sidecar yet (or corrupt) — URL-derived names below */
    }
    return {};
  };
  const savedNames = await readNames();
  let namesDirty = false;
  let namesFlushTimer: ReturnType<typeof setTimeout> | null = null;
  let namesWriteChain: Promise<void> = Promise.resolve();
  const flushPageNames = (): Promise<void> => {
    if (namesFlushTimer) { clearTimeout(namesFlushTimer); namesFlushTimer = null; }
    if (!namesDirty) return namesWriteChain;
    namesDirty = false;
    const payload = JSON.stringify(savedNames);
    namesWriteChain = namesWriteChain.then(async () => {
      try {
        const tmp = `${namesPath}.tmp`;
        await fs.promises.writeFile(tmp, payload);
        await fs.promises.rename(tmp, namesPath);
      } catch {
        /* best-effort: resume falls back to URL-derived names */
      }
    });
    return namesWriteChain;
  };
  const recordPageName = (index: number, name: string): void => {
    savedNames[String(index)] = name;
    namesDirty = true;
    if (!namesFlushTimer) {
      namesFlushTimer = setTimeout(() => { void flushPageNames(); }, 750);
    }
  };

  // Resume-from-partial: page files from an earlier attempt live in tmpDir as
  // bare index names ("0", "1", …). Trust only a consecutive prefix starting
  // at index 0 — parallel workers can leave interior holes, so anything past
  // the first missing file is re-downloaded (overwriting a stale extra file
  // is harmless). Valid files become part of the result without a re-fetch.
  // Pages land complete-or-absent (fetch writes to `i.part`, atomic rename to
  // `i`), so an interrupted fetch never shows up here — leftover `.part`
  // files are simply never counted.
  const resumedSizes = new Map<number, number>();
  for (let i = 0; i < total; i++) {
    try {
      const st = await fs.promises.stat(path.join(tmpDir, String(i)));
      if (!st.isFile() || st.size <= 0) break;
      resumedSizes.set(i, st.size);
    } catch {
      break;
    }
  }
  for (const [i] of resumedSizes) {
    out[i] = { name: savedNames[String(i)] ?? `${padPage(i + 1, total)}.${extFromUrl(pages[i])}`, path: path.join(tmpDir, String(i)) };
  }

  // Per-run byte-level accounting used to derive a live bytes-current/total.
  const bs = {
    actual: new Map<number, number>(), // index -> final page size
    inflight: new Map<number, number>(), // index -> partial bytes received
    known: new Map<number, number>(), // index -> content-length (when the server reports it)
    completed: new Set<number>(),
    lastT: Date.now(),
    lastBytes: 0,
    ema: 0,
  };
  // Seed the byte accounting with the resumed pages so speed/bytes never
  // report a spurious re-download of data already on disk.
  for (const [i, size] of resumedSizes) {
    bs.actual.set(i, size);
    bs.completed.add(i);
  }
  const currentBytes = (): number => {
    let sum = 0;
    for (const v of bs.actual.values()) sum += v;
    for (const [i, v] of bs.inflight) {
      const cap = bs.known.get(i);
      sum += cap ? Math.min(v, cap) : v;
    }
    return sum;
  };
  // Baseline the speed window at the resumed byte total so the EMA does not
  // spike on the first tick after a resume.
  bs.lastBytes = currentBytes();

  const estimateTotal = (): number => {
    const completedCount = bs.completed.size;
    let completedBytes = 0;
    for (const v of bs.actual.values()) completedBytes += v;
    const avg = completedCount > 0 ? completedBytes / completedCount : 0;
    let est = 0;
    for (let i = 0; i < total; i++) {
      if (bs.completed.has(i)) est += bs.actual.get(i) ?? 0;
      else if (bs.known.has(i)) est += bs.known.get(i) ?? 0;
      else est += avg;
    }
    return Math.max(Math.round(est), Math.round(currentBytes()));
  };

  const speed = (): number => {
    const now = Date.now();
    const dt = (now - bs.lastT) / 1000;
    if (dt > 0.05) {
      const cur = currentBytes();
      const inst = Math.max(0, (cur - bs.lastBytes) / dt);
      bs.ema = bs.ema === 0 ? inst : bs.ema * 0.6 + inst * 0.4;
      bs.lastT = now;
      bs.lastBytes = cur;
    }
    return Math.round(bs.ema);
  };

  let lastFileName: string | null = null;
  // Pages download concurrently, so the raw "last network event" would make
  // the label bounce backwards within the in-flight window (e.g. a late chunk
  // from page 83 after page 87). Track the frontier — the highest page index
  // touched so far — which only ever moves forward.
  let frontier = resumedSizes.size;
  let lastReport = 0;
  const touchPage = (i: number): void => {
    if (i + 1 > frontier) frontier = i + 1;
    lastFileName = `Page ${frontier}/${total}`;
  };
  const report = (forceBroadcast: boolean): void => {
    const now = Date.now();
    if (!forceBroadcast && now - lastReport < 100) return;
    lastReport = now;
    updateProgress(
      taskId,
      {
        progressCurrent: bs.completed.size,
        progressTotal: total,
        speed: speed(),
        currentFile: lastFileName,
        bytesCurrent: Math.round(currentBytes()),
        bytesTotal: estimateTotal(),
      },
      { forceBroadcast },
    );
  };

  const onChunk = (i: number, received: number, totalBytes: number | null): void => {
    if (totalBytes && totalBytes > 0) bs.known.set(i, totalBytes);
    bs.inflight.set(i, received);
    touchPage(i);
    report(false);
  };

  const onPageDone = (i: number, size: number): void => {
    bs.actual.set(i, size);
    bs.completed.add(i);
    bs.inflight.delete(i);
    touchPage(i);
    report(true);
  };

  // Emit resumed progress immediately so the UI shows already-saved pages/bytes
  // right away instead of flashing 0 of N until the next page finishes.
  if (resumedSizes.size > 0) {
    lastFileName = resumedSizes.size < total ? `Page ${resumedSizes.size}/${total}` : null;
    report(true);
  }

  const checkStop = (): void => {
    if (ctx.cancelled) throw new Error('Cancelled by user');
    if (ctx.paused) throw new DownloadPausedError();
    if (ctx.shuttingDown) throw new DownloadShutdownError();
  };

  let nextIndex = resumedSizes.size;
  const worker = async (): Promise<void> => {
    while (true) {
      checkStop();
      if (ctx.stopped) return;
      if (ctx.pauseSignal.paused) {
        // Park until resume()/cancel() settles the pause gate — event-driven,
        // so a paused run costs no polling timers and wakes the instant it
        // is resumed or cancelled.
        await new Promise<void>((resolve) => ctx.pauseSignal.waiters.push(resolve));
        checkStop();
        if (ctx.stopped) return;
        continue;
      }
      const i = nextIndex++;
      if (i >= total) break;
      const filePath = path.join(tmpDir, String(i));
      let size: number | null = null;
      let ext: string | null = null;
      let lastErr: unknown = null;

      if (gallery.downloadPage) {
        // Provider-managed secure/paced transfer (e.g. E-Hentai H@H with DNS pinning,
        // per-lane pacing, magic-byte validation, and `?nl=` node switching).
        const maxAttempts = 4;
        const backoff = [2000, 6000, 15000];
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          checkStop();
          if (ctx.stopped) return;
          try {
            const result = await gallery.downloadPage(i, filePath, {
              forceRefresh: attempt > 0,
              signal: ctx.controller.signal,
              onAttemptStart: () => {
                bs.inflight.set(i, 0);
              },
              onProgress: (received, totalBytes) => onChunk(i, received, totalBytes),
            });
            size = result.bytes;
            ext = result.ext;
            break;
          } catch (err) {
            bs.inflight.delete(i);
            lastErr = err;
            checkStop();
            if (ctx.stopped) return;
            const refreshable = isRouteRefreshableError(err);
            const transient = isTransientError(err);
            if ((!refreshable && !transient) || attempt >= maxAttempts - 1) break;
            if (refreshable && !transient) {
              // Stale H@H node (404/410): switch nodes via `?nl=` promptly without a long wait.
              continue;
            }
            const advised = errorRetryAfterMs(err);
            const waitMs = advised !== null ? Math.max(advised, 250) : jitterDelay(backoff[attempt] ?? backoff[backoff.length - 1]);
            await sleep(waitMs, ctx.controller.signal);
          }
        }
      } else {
        // Re-resolve the page URL against the provider's *current* CDN routing
        // state right before fetching, so long downloads survive base-path
        // rotation. On a stale route (404/410) with a live resolver, refresh
        // immediately; on a transient storm, back off briefly before refreshing;
        // on permanent errors (401/403/static 404), fail without wasting 30s.
        let usedUrl: string | null = null;
        for (const force of [false, true]) {
          checkStop();
          if (ctx.stopped) return;
          if (force) {
            if (!gallery.resolvePageUrl) break;
            const refreshable = isRouteRefreshableError(lastErr);
            const transient = isTransientError(lastErr);
            if (!refreshable && !transient) break;
            if (!refreshable) {
              const advised = errorRetryAfterMs(lastErr);
              const waitMs = advised !== null ? Math.max(advised, 250) : jitterDelay(15_000);
              await sleep(waitMs, ctx.controller.signal);
            }
            checkStop();
            if (ctx.stopped) return;
          }
          const candidates = await resolvePageCandidates(gallery, i, force, ctx.controller.signal);
          for (const url of candidates) {
            checkStop();
            if (ctx.stopped) return;
            try {
              size = await fetchPageToFileWithRetry(url, pageHeaders, filePath, {
                onAttemptStart: () => {
                  bs.inflight.set(i, 0);
                },
                onProgress: (received, totalBytes) => onChunk(i, received, totalBytes),
              }, ctx.controller.signal);
              usedUrl = url;
              break;
            } catch (err) {
              bs.inflight.delete(i);
              lastErr = err;
            }
          }
          if (size != null) break;
        }
        if (size != null) ext = extFromUrl(usedUrl ?? pages[i]);
      }

      if (size == null) throw lastErr instanceof Error ? lastErr : new Error(`Failed to download page ${i + 1}`);
      const name = `${padPage(i + 1, total)}.${ext || extFromUrl(pages[i])}`;
      out[i] = { name, path: filePath };
      recordPageName(i, name);
      onPageDone(i, size);
      if (delay > 0) await sleep(delay, ctx.controller.signal);
    }
  };

  const workers = Array.from({ length: Math.min(concurrency, total) }, () => worker().catch((error) => {
    ctx.stopped = true;
    ctx.controller.abort(error);
    wakePaused(ctx);
    throw error;
  }));
  const settled = await Promise.allSettled(workers);
  await flushPageNames();
  const failed = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failed) throw failed.reason;
  updateProgress(
    taskId,
    {
      progressCurrent: bs.completed.size,
      progressTotal: total,
      speed: 0,
      currentFile: null,
      bytesCurrent: Math.round(currentBytes()),
      bytesTotal: estimateTotal(),
    },
    { force: true },
  );
  return out;
}
