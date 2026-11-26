import fs from 'node:fs';
import path from 'node:path';
import type { DoujinGallery } from './types.js';
import type { DownloaderSettings } from '../services/settings.js';
import { mapLimit, sleep } from '../lib/http.js';
import { extFromUrl, padPage } from './util.js';
import {
  errorRetryAfterMs,
  fetchCandidatesToFileWithRetry,
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
      namesFlushTimer.unref?.();
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
  let prefixLen = 0;
  try {
    const existingNames = new Set(await fs.promises.readdir(tmpDir));
    while (prefixLen < total && existingNames.has(String(prefixLen))) prefixLen++;
  } catch {
    /* empty or unreadable scratch dir — start from page 0 */
  }
  if (prefixLen > 0) {
    const indices = Array.from({ length: prefixLen }, (_, idx) => idx);
    const sizes = await mapLimit(indices, 16, async (idx) => {
      try {
        const st = await fs.promises.stat(path.join(tmpDir, String(idx)));
        return st.isFile() && st.size > 0 ? st.size : 0;
      } catch {
        return 0;
      }
    });
    for (let i = 0; i < sizes.length; i++) {
      if (sizes[i] <= 0) break;
      resumedSizes.set(i, sizes[i]);
    }
  }
  for (const [i] of resumedSizes) {
    out[i] = { name: savedNames[String(i)] ?? `${padPage(i + 1, total)}.${extFromUrl(pages[i])}`, path: path.join(tmpDir, String(i)) };
  }

  // Per-run byte-level accounting used to derive a live bytes-current/total.
  // Running sums are maintained incrementally so every progress tick is O(1)
  // instead of re-summing per-page maps (O(pages) on each chunk).
  const bs = {
    actual: new Map<number, number>(), // index -> final page size
    inflight: new Map<number, number>(), // index -> partial bytes received
    inflightCounted: new Map<number, number>(), // index -> its (capped) share of inflightSum
    known: new Map<number, number>(), // index -> content-length (when the server reports it)
    completed: new Set<number>(),
    actualSum: 0,
    inflightSum: 0,
    knownPendingSum: 0, // content-lengths of pages not yet completed
    knownPendingCount: 0,
    lastT: Date.now(),
    lastBytes: 0,
    ema: 0,
  };
  const recountInflight = (i: number): void => {
    const received = bs.inflight.get(i);
    const before = bs.inflightCounted.get(i) ?? 0;
    if (received === undefined) {
      bs.inflightSum -= before;
      bs.inflightCounted.delete(i);
      return;
    }
    const cap = bs.known.get(i);
    const counted = cap ? Math.min(received, cap) : received;
    bs.inflightSum += counted - before;
    bs.inflightCounted.set(i, counted);
  };
  const setInflight = (i: number, received: number): void => {
    bs.inflight.set(i, received);
    recountInflight(i);
  };
  const clearInflight = (i: number): void => {
    bs.inflight.delete(i);
    recountInflight(i);
  };
  const setKnown = (i: number, length: number): void => {
    const previous = bs.known.get(i);
    if (previous === length) return;
    bs.known.set(i, length);
    if (!bs.completed.has(i)) {
      if (previous === undefined) bs.knownPendingCount++;
      bs.knownPendingSum += length - (previous ?? 0);
    }
    recountInflight(i);
  };
  const markCompleted = (i: number, size: number): void => {
    bs.actualSum += size - (bs.actual.get(i) ?? 0);
    bs.actual.set(i, size);
    if (!bs.completed.has(i)) {
      bs.completed.add(i);
      const length = bs.known.get(i);
      if (length !== undefined) {
        bs.knownPendingCount--;
        bs.knownPendingSum -= length;
      }
    }
    clearInflight(i);
  };
  // Seed the byte accounting with the resumed pages so speed/bytes never
  // report a spurious re-download of data already on disk.
  for (const [i, size] of resumedSizes) markCompleted(i, size);
  const currentBytes = (): number => bs.actualSum + bs.inflightSum;
  // Baseline the speed window at the resumed byte total so the EMA does not
  // spike on the first tick after a resume.
  bs.lastBytes = currentBytes();

  const estimateTotal = (): number => {
    const completedCount = bs.completed.size;
    const avg = completedCount > 0 ? bs.actualSum / completedCount : 0;
    const unknownCount = Math.max(0, total - completedCount - bs.knownPendingCount);
    const est = bs.actualSum + bs.knownPendingSum + unknownCount * avg;
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
  // A throttled tick schedules one trailing report, so the latest state (e.g.
  // a page that completed just after a tick) is never stranded until the next
  // chunk arrives.
  let trailingReport: ReturnType<typeof setTimeout> | null = null;
  const report = (forceBroadcast: boolean): void => {
    const now = Date.now();
    if (!forceBroadcast && now - lastReport < 100) {
      trailingReport ??= setTimeout(() => {
        trailingReport = null;
        report(false);
      }, 100 - (now - lastReport));
      return;
    }
    if (trailingReport) {
      clearTimeout(trailingReport);
      trailingReport = null;
    }
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
    if (totalBytes && totalBytes > 0) setKnown(i, totalBytes);
    setInflight(i, received);
    touchPage(i);
    report(false);
  };

  const onPageDone = (i: number, size: number): void => {
    markCompleted(i, size);
    touchPage(i);
    // Throttled like byte ticks: intermediate pages need no forced SSE frame
    // (the final page is followed by the forced completion update below).
    report(bs.completed.size >= total);
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
  let preferredMirror = 0;
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
                setInflight(i, 0);
              },
              onProgress: (received, totalBytes) => onChunk(i, received, totalBytes),
            });
            size = result.bytes;
            ext = result.ext;
            break;
          } catch (err) {
            clearInflight(i);
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
          if (candidates.length > 0) {
            checkStop();
            if (ctx.stopped) return;
            try {
              const result = await fetchCandidatesToFileWithRetry(
                candidates,
                pageHeaders,
                filePath,
                {
                  onAttemptStart: () => {
                    setInflight(i, 0);
                  },
                  onProgress: (received, totalBytes) => onChunk(i, received, totalBytes),
                },
                ctx.controller.signal,
                force ? 0 : preferredMirror,
              );
              size = result.bytes;
              usedUrl = result.url;
              preferredMirror = result.index;
            } catch (err) {
              clearInflight(i);
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
      if (delay > 0 && nextIndex < total) await sleep(delay, ctx.controller.signal);
    }
  };

  const workers = Array.from({ length: Math.min(concurrency, total) }, () => worker().catch((error) => {
    ctx.stopped = true;
    ctx.controller.abort(error);
    wakePaused(ctx);
    throw error;
  }));
  const settled = await Promise.allSettled(workers);
  if (trailingReport) {
    clearTimeout(trailingReport);
    trailingReport = null;
  }
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
