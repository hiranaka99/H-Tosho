import * as fsp from 'node:fs/promises';

/**
 * Small shared HTTP helpers for outbound calls to providers & Kavita.
 */

export interface HttpResponse<T = unknown> {
  status: number;
  data: T;
  /** Response headers (exposed so retry wrappers can read Retry-After). */
  headers?: Headers;
}

export interface FetchJsonOptions {
  /**
   * Return non-2xx responses instead of throwing. Callers that build their own
   * status-specific errors (Kavita client, metadata providers, the nhentai 429
   * retry loop) opt in explicitly; everyone else gets a thrown Error so HTTP
   * failures cannot be silently ignored.
   */
  raw?: boolean;
}

export async function fetchJson<T = unknown>(
  url: string,
  init: RequestInit = {},
  timeoutMs = 15_000,
  opts: FetchJsonOptions = {},
): Promise<HttpResponse<T>> {
  init.signal?.throwIfAborted();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...init,
      signal: init.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal,
      redirect: 'follow',
    });
    const text = await res.text();
    let data: T;
    try {
      data = text ? (JSON.parse(text) as T) : (undefined as T);
    } catch {
      data = text as unknown as T;
    }
    if (!res.ok && !opts.raw) {
      // Strip the query string from the display URL — some endpoints carry
      // credentials in it.
      throw new Error(`HTTP ${res.status} from ${url.split('?')[0]}`);
    }
    return { status: res.status, data, headers: res.headers };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchBuffer(
  url: string,
  init: RequestInit = {},
  timeoutMs = 30_000,
): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

/** Callbacks for byte-level progress while a response body streams in. */
export interface StreamProgressHandlers {
  /** Invoked before each (re)attempt begins — useful for resetting per-item counters. */
  onAttemptStart?: () => void;
  /** Invoked after each received chunk with cumulative bytes and the known total (or null). */
  onProgress?: (receivedBytes: number, totalBytes: number | null) => void;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal?.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

const RETRYABLE_STATUS: Record<number, true> = { 429: true, 502: true, 503: true, 504: true };

/** HTTP status error carrying any server-advised Retry-After delay (ms). */
export class HttpStatusError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'HttpStatusError';
  }
}

/** Parse a Retry-After header (delay seconds or HTTP date) into ms; null when absent/invalid. */
export function parseRetryAfterMs(headers: Headers | Record<string, string | string[] | undefined> | undefined, maxMs = 15_000): number | null {
  if (!headers) return null;
  const raw = headers instanceof Headers
    ? headers.get('retry-after')
    : (() => {
        const value = headers['retry-after'];
        return Array.isArray(value) ? value[0] : value ?? null;
      })();
  if (!raw) return null;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.max(0, Math.min(secs * 1000, maxMs));
  const date = Date.parse(raw);
  return Number.isNaN(date) ? null : Math.max(0, Math.min(date - Date.now(), maxMs));
}

function retryAfterMs(headers: Headers | undefined): number | null {
  return parseRetryAfterMs(headers, 15_000);
}

/**
 * fetchJson with retry on transient upstream failures: HTTP 429/502/503/504 and
 * network errors. Honors Retry-After when present, otherwise exponential
 * backoff. Non-retryable failures and exhausted attempts behave exactly like
 * fetchJson (throw unless opts.raw).
 */
export async function fetchJsonRetry<T = unknown>(
  url: string,
  init: RequestInit = {},
  timeoutMs = 15_000,
  opts: FetchJsonOptions = {},
  attempts = 3,
): Promise<HttpResponse<T>> {
  for (let attempt = 1; ; attempt++) {
    let res: HttpResponse<T>;
    try {
      // raw:true so 429/5xx statuses reach the retry check instead of throwing.
      res = await fetchJson<T>(url, init, timeoutMs, { ...opts, raw: true });
    } catch (e) {
      init.signal?.throwIfAborted();
      if (attempt >= attempts) throw e;
      await sleep(Math.min(500 * 2 ** (attempt - 1), 4000), init.signal ?? undefined);
      continue;
    }
    if (RETRYABLE_STATUS[res.status] && attempt < attempts) {
      await sleep(retryAfterMs(res.headers) ?? Math.min(500 * 2 ** (attempt - 1), 4000), init.signal ?? undefined);
      continue;
    }
    if (!(res.status >= 200 && res.status < 300) && !opts.raw) {
      throw new Error(`HTTP ${res.status} from ${url.split('?')[0]}`);
    }
    return res;
  }
}

/**
 * Map over items with at most `limit` calls in flight. The first failure stops
 * workers from claiming new items, but all in-flight calls are awaited before
 * the error is rethrown so callers can safely release shared cancellation state.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  let firstError: unknown;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      if (failed) return;
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i], i);
      } catch (error) {
        if (!failed) firstError = error;
        failed = true;
        return;
      }
    }
  });
  await Promise.all(workers);
  if (failed) throw firstError;
  return results;
}

export interface FetchToFileOptions {
  /** Reject HTML/XHTML bodies returned with HTTP 200 (e.g. CDN error or challenge pages). */
  rejectHtml?: boolean;
}

/**
 * Fetch a URL straight to a file, streaming the body to disk so page-sized
 * images never transit RAM twice. Writes to `destPath + '.part'` and atomically renames on success so
 * consumers only ever see complete files; the .part file is removed on
 * failure. `timeoutMs` aborts an idle transfer, not a slow transfer receiving bytes.
 * Returns the number of bytes written.
 */
export async function fetchToFileStreaming(
  url: string,
  init: RequestInit,
  destPath: string,
  handlers: StreamProgressHandlers = {},
  timeoutMs = 30_000,
  opts: FetchToFileOptions = {},
): Promise<number> {
  init.signal?.throwIfAborted();
  const partPath = `${destPath}.part`;
  const fh = await fsp.open(partPath, 'w');
  let closed = false;
  const closeFile = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await fh.close();
  };
  const controller = new AbortController();
  const signal = init.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal;
  let timer = setTimeout(() => controller.abort(), timeoutMs);
  const armTimer = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), timeoutMs);
  };
  let reader: { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel?: () => Promise<unknown> } | null = null;
  try {
    signal.throwIfAborted();
    const res = await fetch(url, { ...init, signal, redirect: 'follow' });
    if (!res.ok) {
      throw new HttpStatusError(`Download failed: HTTP ${res.status}`, res.status, parseRetryAfterMs(res.headers, 60_000));
    }
    armTimer(); // headers received — start the idle window for the body
    if (opts.rejectHtml) {
      const mediaType = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
      if (mediaType === 'text/html' || mediaType === 'application/xhtml+xml') {
        throw new Error('Download failed: unexpected HTML response instead of image');
      }
    }
    const lengthHeader = res.headers.get('content-length');
    const parsedLength = lengthHeader ? Number(lengthHeader) : NaN;
    const totalBytes = Number.isFinite(parsedLength) && parsedLength > 0 ? parsedLength : null;
    const hasEncoding = Boolean(res.headers.get('content-encoding'));
    handlers.onAttemptStart?.();

    interface StreamReader {
      read(): Promise<{ done: boolean; value?: Uint8Array }>;
      cancel?: () => Promise<unknown>;
    }
    const body = res.body as unknown as { getReader?: () => StreamReader } | null;
    if (!body || typeof body.getReader !== 'function') {
      const buf = Buffer.from(await res.arrayBuffer());
      signal.throwIfAborted();
      if (buf.length === 0) throw new Error('Empty response body (0 bytes)');
      if (totalBytes !== null && !hasEncoding && buf.length < totalBytes) {
        throw new Error(`Incomplete download: received ${buf.length} of ${totalBytes} bytes`);
      }
      await fh.write(buf);
      handlers.onProgress?.(buf.length, totalBytes ?? buf.length);
      await closeFile();
      await fsp.rename(partPath, destPath);
      return buf.length;
    }

    reader = body.getReader();
    let written = 0;
    for (;;) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      if (value) {
        armTimer(); // bytes arrived — reset the idle window
        await fh.write(value);
        written += value.byteLength;
        handlers.onProgress?.(written, totalBytes);
      }
    }
    if (written === 0) throw new Error('Empty response body (0 bytes)');
    if (totalBytes !== null && !hasEncoding && written < totalBytes) {
      throw new Error(`Incomplete download: received ${written} of ${totalBytes} bytes`);
    }
    await closeFile();
    await fsp.rename(partPath, destPath);
    return written;
  } catch (e) {
    await reader?.cancel?.().catch(() => {});
    await closeFile().catch(() => {});
    await fsp.unlink(partPath).catch(() => {});
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
