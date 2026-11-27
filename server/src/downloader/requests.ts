import {
  fetchToFileStreaming,
  HttpStatusError,
  sleep,
  type StreamProgressHandlers,
} from "../lib/http.js";
import type { DoujinGallery } from "./types.js";
import type { DownloadErrorCode } from "../contracts/downloads.js";
import { EhentaiUpstreamError } from "./ehentaiClient.js";
import { RequestAbortedError } from "./ehentaiGate.js";
import { DownloadPausedError, DownloadShutdownError } from "./runtime.js";

/** Apply ±20% jitter so concurrent workers do not stampede an upstream CDN in lockstep. */
export function jitterDelay(baseMs: number): number {
  if (baseMs <= 0) return 0;
  return Math.max(0, Math.round(baseMs * (0.8 + Math.random() * 0.4)));
}

/** Extract any upstream-advised Retry-After delay (ms) carried by an error. */
export function errorRetryAfterMs(err: unknown): number | null {
  if (err instanceof HttpStatusError) return err.retryAfterMs;
  if (err instanceof EhentaiUpstreamError) return err.retryAfterMs;
  return null;
}

/** True when a failure indicates a stale/rotated CDN route (404/410 or unexpected HTML)
 *  that is worth refreshing immediately via `resolvePageUrl(..., { forceRefresh: true })`. */
export function isRouteRefreshableError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (
    err instanceof DownloadPausedError ||
    err instanceof DownloadShutdownError ||
    err instanceof RequestAbortedError
  )
    return false;
  if (err instanceof EhentaiUpstreamError) {
    if (err.kind === "quota" || err.kind === "denied" || err.kind === "blocked")
      return false;
    return err.status === 404 || err.status === 410 || err.kind === "parse";
  }
  if (err instanceof HttpStatusError)
    return err.status === 404 || err.status === 410;
  return /HTTP (?:404|410)\b|unexpected HTML response/i.test(err.message);
}

/** True when a fetch error is transient (worth retrying with backoff). */
export function isTransientError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (
    err instanceof DownloadPausedError ||
    err instanceof DownloadShutdownError ||
    err instanceof RequestAbortedError
  )
    return false;
  if (/Cancelled by user/i.test(err.message)) return false;
  if (err instanceof EhentaiUpstreamError) {
    if (
      err.kind === "quota" ||
      err.kind === "denied" ||
      err.kind === "blocked" ||
      err.kind === "parse"
    )
      return false;
    if (err.kind === "timeout" || err.kind === "rate-limited") return true;
    // `unavailable` with a 4xx status (e.g. 404 removed gallery) is permanent; 5xx/connection blips are transient.
    return (
      err.status === null ||
      err.status === 408 ||
      err.status === 429 ||
      (err.status >= 500 && err.status <= 504)
    );
  }
  if (err instanceof HttpStatusError) {
    return (
      err.status === 408 ||
      err.status === 429 ||
      (err.status >= 500 && err.status <= 504)
    );
  }
  const m = /HTTP (\d{3})/.exec(err.message);
  if (m) {
    const code = parseInt(m[1], 10);
    // Rate-limit, request-timeout, and server-side errors are transient.
    return code === 408 || code === 429 || (code >= 500 && code <= 504);
  }
  return /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|socket hang up|network|aborted|timed?\s*out|ENOTFOUND|Incomplete download|Empty response|other side closed|terminated/i.test(
    err.message
  );
}

/**
 * Stream a URL straight to a file, retrying transient failures (429/5xx/network/truncation)
 * with jittered backoff and Retry-After respect. Non-transient errors are rethrown
 * immediately so the caller can fall through to a per-page fallback or route refresh
 * without needless retries. Pages land complete-or-absent (`.part` + atomic rename),
 * so a crash never leaves a truncated file under the bare name the resume scan stats.
 */
export async function fetchPageToFileWithRetry(
  url: string,
  headers: Record<string, string>,
  destPath: string,
  handlers: StreamProgressHandlers,
  signal?: AbortSignal
): Promise<number> {
  const attempts = 5;
  const delays = [2000, 6000, 15000, 40000];
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    signal?.throwIfAborted();
    try {
      return await fetchToFileStreaming(
        url,
        { headers, signal },
        destPath,
        handlers,
        30_000,
        { rejectHtml: true }
      );
    } catch (err) {
      lastErr = err;
      signal?.throwIfAborted();
      if (!isTransientError(err)) throw err;
      if (i < attempts - 1) {
        const advised = errorRetryAfterMs(err);
        const waitMs =
          advised !== null
            ? Math.max(advised, 250)
            : jitterDelay(delays[i] ?? delays[delays.length - 1]);
        await sleep(waitMs, signal);
      }
    }
  }
  throw lastErr;
}

/**
 * Download one page across an ordered list of mirror candidates, rotating
 * through every remaining mirror within each retry round before sleeping.
 * Permanently failing (non-transient) mirrors are dropped after their first
 * failure so healthy fallback mirrors are reached on the first round.
 */
export async function fetchCandidatesToFileWithRetry(
  candidates: string[],
  headers: Record<string, string>,
  destPath: string,
  handlers: StreamProgressHandlers,
  signal?: AbortSignal,
  startIndex = 0
): Promise<{ bytes: number; url: string; index: number }> {
  if (!candidates.length)
    throw new Error("No candidate URLs available for page download");
  const attempts = 5;
  const delays = [2000, 6000, 15000, 40000];
  const offset =
    ((startIndex % candidates.length) + candidates.length) % candidates.length;
  const ordered = candidates.map((_, idx) => {
    const index = (offset + idx) % candidates.length;
    return { index, url: candidates[index] };
  });
  const permanentFailures = new Set<number>();
  let lastErr: unknown;

  for (let round = 0; round < attempts; round++) {
    let minRetryAfter: number | null = null;
    for (const candidate of ordered) {
      if (permanentFailures.has(candidate.index)) continue;
      signal?.throwIfAborted();
      try {
        const bytes = await fetchToFileStreaming(
          candidate.url,
          { headers, signal },
          destPath,
          handlers,
          30_000,
          { rejectHtml: true }
        );
        return { bytes, url: candidate.url, index: candidate.index };
      } catch (err) {
        lastErr = err;
        signal?.throwIfAborted();
        if (!isTransientError(err)) {
          permanentFailures.add(candidate.index);
          continue;
        }
        const advised = errorRetryAfterMs(err);
        if (advised !== null) {
          minRetryAfter =
            minRetryAfter === null ? advised : Math.min(minRetryAfter, advised);
        }
      }
    }
    if (permanentFailures.size >= ordered.length || round >= attempts - 1)
      break;
    const waitMs =
      minRetryAfter !== null
        ? Math.max(minRetryAfter, 250)
        : jitterDelay(delays[round] ?? delays[delays.length - 1]);
    await sleep(waitMs, signal);
  }
  throw lastErr;
}

/**
 * Run an async operation, retrying transient failures with the given delays.
 * Non-transient errors are rethrown immediately. Used for gallery resolution
 * and anywhere a single request can hit a CDN blip.
 */
export async function retryTransient<T>(
  fn: () => Promise<T>,
  attempts: number,
  delays: number[],
  signal?: AbortSignal
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < Math.max(1, attempts); i++) {
    signal?.throwIfAborted();
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      signal?.throwIfAborted();
      if (!isTransientError(err) || i >= attempts - 1) throw err;
      const advised = errorRetryAfterMs(err);
      const waitMs =
        advised !== null
          ? Math.max(advised, 250)
          : (delays[i] ?? delays[delays.length - 1]);
      await sleep(waitMs, signal);
    }
  }
  throw lastErr;
}

/**
 * Build the ordered list of candidate URLs for a page, re-resolving them against
 * the provider's *current* CDN routing state when it supports a live resolver
 * (Hitomi/nHentai). Providers without one fall back to the static URL captured at
 * resolve time. `forceRefresh` asks the provider to re-fetch its routing table
 * first — used after a failure that may be caused by a rotated/stale base path.
 */
export async function resolvePageCandidates(
  gallery: DoujinGallery,
  i: number,
  forceRefresh = false,
  signal?: AbortSignal
): Promise<string[]> {
  signal?.throwIfAborted();
  if (gallery.resolvePageUrl) {
    try {
      const r = await gallery.resolvePageUrl(i, { forceRefresh, signal });
      if (r && typeof r.url === "string" && r.url.length > 0) {
        const candidates = [r.url];
        const extras = Array.isArray(r.fallbacks)
          ? r.fallbacks
          : typeof r.fallback === "string" && r.fallback
            ? [r.fallback]
            : [];
        for (const extra of extras) {
          if (
            typeof extra === "string" &&
            extra.length > 0 &&
            !candidates.includes(extra)
          )
            candidates.push(extra);
        }
        return candidates;
      }
      // The index is known to the resolver but it returned nothing. For strict
      // providers the static URL is not downloadable (it is HTML), so a null
      // must fail the page rather than publish a non-image.
      if (gallery.strictPageResolver && typeof gallery.pages[i] === "string") {
        throw new Error(
          `Page ${i + 1} could not be resolved to a downloadable URL.`
        );
      }
    } catch (error) {
      if (signal?.aborted || gallery.strictPageResolver) throw error;
      /* fall through to the static URLs */
    }
  }
  const primary = gallery.pages[i];
  const fallback = gallery.pageFallbacks?.[i];
  return [primary, fallback].filter(
    (u): u is string => typeof u === "string" && u.length > 0
  );
}

/** Classify external errors once for persisted state and client guidance. */
export function classifyDownloadError(
  error: unknown,
  cancelled = false
): DownloadErrorCode {
  if (cancelled) return "cancelled";
  if (error instanceof EhentaiUpstreamError) {
    if (error.kind === "quota") return "quota";
    if (error.kind === "denied") return "access-denied";
    if (error.kind === "rate-limited") return "rate-limit";
    if (error.kind === "timeout") return "network";
    if (error.kind === "unavailable") {
      if (error.status !== null && error.status >= 500 && error.status < 600)
        return "upstream";
      if (error.status === 404 || error.status === 410)
        return "download-failed";
      return "network";
    }
    return "download-failed";
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/ENOSPC|EDQUOT|no space left|disk full/i.test(message))
    return "disk-full";
  if (/EACCES|EPERM|permission denied|read.only|EROFS/i.test(message))
    return "permissions";
  if (/download directory|output folder|ENOENT/i.test(message))
    return "output-missing";
  if (/509|quota/i.test(message)) return "quota";
  if (/401|403|api.?key|unauthorized|forbidden/i.test(message))
    return "access-denied";
  if (/429|rate.?limit|too many requests/i.test(message)) return "rate-limit";
  if (/HTTP 50\d|unavailable|bad gateway/i.test(message)) return "upstream";
  return isTransientError(error) ? "network" : "download-failed";
}
