import fs from 'node:fs';
import path from 'node:path';
import type { DoujinGallery } from './types.js';
import type { DownloaderSettings } from '../services/settings.js';
import { sleep } from '../lib/http.js';
import { extFromUrl, padPage } from './util.js';
import { fetchPageToFileWithRetry, resolvePageCandidates } from './requests.js';
import { wakePaused, type RunContext, type LiveFields } from './runtime.js';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 H-Tosho/1.0';
export async function downloadPages(
  gallery: DoujinGallery,
  taskId: number,
  settings: DownloaderSettings,
  ctx: RunContext,
  tmpDir: string,
  updateProgress: (id: number, patch: LiveFields, options?: { force?: boolean }) => void,
): Promise<{ name: string; path: string }[]> {
  const pages = gallery.pages;
  const total = pages.length;
  const concurrency = Math.max(1, settings.maxImageConcurrency || 1);
  const delay = Math.max(0, settings.requestDelayMs || 0);
  const pageHeaders: Record<string, string> = { 'User-Agent': UA, ...gallery.requestHeaders };
  fs.mkdirSync(tmpDir, { recursive: true });
  const out: { name: string; path: string }[] = new Array(total);

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
    out[i] = { name: `${padPage(i + 1, total)}.${extFromUrl(pages[i])}`, path: path.join(tmpDir, String(i)) };
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
  const report = (force: boolean): void => {
    const now = Date.now();
    if (!force && now - lastReport < 100) return;
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
      { force },
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

  let nextIndex = resumedSizes.size;
  const worker = async (): Promise<void> => {
    while (true) {
      if (ctx.cancelled) throw new Error('Cancelled by user');
      if (ctx.stopped) return;
      if (ctx.pauseSignal.paused) {
        // Park until resume()/cancel() settles the pause gate — event-driven,
        // so a paused run costs no polling timers and wakes the instant it
        // is resumed or cancelled.
        await new Promise<void>((resolve) => ctx.pauseSignal.waiters.push(resolve));
        if (ctx.cancelled) throw new Error('Cancelled by user');
        if (ctx.stopped) return;
        continue;
      }
      const i = nextIndex++;
      if (i >= total) break;
      // Re-resolve the page URL against the provider's *current* CDN routing
      // state right before fetching, so long downloads survive base-path
      // rotation. If both primary and fallback fail, force a routing-table
      // refresh (the CDN may have rotated) and try once more before giving up.
      // Each candidate streams straight to the page's final temp name via
      // `.part` + atomic rename, so only `concurrency` images transit RAM and
      // the resume scan never sees a truncated page.
      const filePath = path.join(tmpDir, String(i));
      let size: number | null = null;
      let usedUrl: string | null = null;
      let lastErr: unknown = null;
      for (const force of [false, true]) {
        if (ctx.cancelled) throw new Error('Cancelled by user');
        if (ctx.stopped) return;
        if (force) await sleep(30_000, ctx.controller.signal); // let a CDN storm clear before re-resolving URLs
        if (ctx.cancelled) throw new Error('Cancelled by user');
        if (ctx.stopped) return;
        const candidates = await resolvePageCandidates(gallery, i, force);
        for (const url of candidates) {
          if (ctx.cancelled) throw new Error('Cancelled by user');
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
            lastErr = err;
          }
        }
        if (size != null) break;
      }
      if (size == null) throw lastErr instanceof Error ? lastErr : new Error(`Failed to download page ${i + 1}`);
      const name = `${padPage(i + 1, total)}.${extFromUrl(usedUrl ?? pages[i])}`;
      out[i] = { name, path: filePath };
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
