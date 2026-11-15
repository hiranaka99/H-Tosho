import { fetchToFileStreaming, sleep, type StreamProgressHandlers } from '../lib/http.js';
import type { DoujinGallery } from './types.js';
import type { DownloadErrorCode } from '../contracts/downloads.js';
/** True when a fetch error is transient (worth retrying with backoff). */
export function isTransientError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const m = /HTTP (\d{3})/.exec(err.message);
  if (m) {
    const code = parseInt(m[1], 10);
    // Rate-limit and server-side errors are transient.
    return code === 429 || (code >= 500 && code <= 504);
  }
  return /fetch failed|ECONNRESET|socket hang up|network|aborted|timeout|ENOTFOUND/i.test(err.message);
}

/**
 * Stream a URL straight to a file, retrying transient failures (429/5xx/network)
 * with growing backoff. Non-transient errors are rethrown immediately so the
 * caller can fall through to a per-page fallback without needless retries.
 * The schedule (~63s of waiting total) is long enough to ride out typical CDN
 * 503 storms, which clear within seconds to a couple of minutes. Pages land
 * complete-or-absent (`.part` + atomic rename), so a crash never leaves a
 * truncated file under the bare name the resume scan stats.
 */
export async function fetchPageToFileWithRetry(
  url: string,
  headers: Record<string, string>,
  destPath: string,
  handlers: StreamProgressHandlers,
  signal?: AbortSignal,
): Promise<number> {
  const attempts = 5;
  const delays = [2000, 6000, 15000, 40000];
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    signal?.throwIfAborted();
    try {
      return await fetchToFileStreaming(url, { headers, signal }, destPath, handlers);
    } catch (err) {
      lastErr = err;
      signal?.throwIfAborted();
      if (!isTransientError(err)) throw err;
      if (i < attempts - 1) await sleep(delays[i] ?? delays[delays.length - 1], signal);
    }
  }
  throw lastErr;
}

/**
 * Run an async operation, retrying transient failures with the given delays.
 * Non-transient errors are rethrown immediately. Used for gallery resolution
 * and anywhere a single request can hit a CDN blip.
 */
export async function retryTransient<T>(fn: () => Promise<T>, attempts: number, delays: number[]): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < Math.max(1, attempts); i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransientError(err) || i >= attempts - 1) throw err;
      await sleep(delays[i] ?? delays[delays.length - 1]);
    }
  }
  throw lastErr;
}

/**
 * Build the ordered list of candidate URLs for a page, re-resolving them against
 * the provider's *current* CDN routing state when it supports a live resolver
 * (Hitomi). Providers without one fall back to the static URL captured at
 * resolve time. `forceRefresh` asks the provider to re-fetch its routing table
 * first — used after a failure that may be caused by a rotated/stale base path.
 */
export async function resolvePageCandidates(
  gallery: DoujinGallery,
  i: number,
  forceRefresh = false,
): Promise<string[]> {
  if (gallery.resolvePageUrl) {
    try {
      const r = await gallery.resolvePageUrl(i, { forceRefresh });
      if (r && typeof r.url === 'string' && r.url.length > 0) {
        return [r.url, ...(typeof r.fallback === 'string' && r.fallback ? [r.fallback] : [])];
      }
    } catch {
      /* fall through to the static URLs */
    }
  }
  const primary = gallery.pages[i];
  const fallback = gallery.pageFallbacks?.[i];
  return [primary, fallback].filter((u): u is string => typeof u === 'string' && u.length > 0);
}

/** Classify external errors once for persisted state and client guidance. */
export function classifyDownloadError(error: unknown, cancelled = false): DownloadErrorCode {
  if (cancelled) return 'cancelled';
  const message = error instanceof Error ? error.message : String(error);
  if (/EACCES|EPERM|permission denied|read.only|EROFS/i.test(message)) return 'permissions';
  if (/download directory|output folder|ENOENT/i.test(message)) return 'output-missing';
  if (/401|403|api.?key|unauthorized|forbidden/i.test(message)) return 'access-denied';
  if (/429|rate.?limit|too many requests/i.test(message)) return 'rate-limit';
  if (/HTTP 50\d|unavailable|bad gateway/i.test(message)) return 'upstream';
  return isTransientError(error) ? 'network' : 'download-failed';
}
