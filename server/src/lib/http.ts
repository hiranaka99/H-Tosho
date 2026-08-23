/**
 * Small shared HTTP helpers for outbound calls to providers & Kavita.
 */

export interface HttpResponse<T = unknown> {
  status: number;
  data: T;
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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
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
    return { status: res.status, data };
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

/**
 * Fetch a URL into a Buffer while streaming the body so callers can observe
 * byte-level progress. `timeoutMs` is an IDLE timeout: it aborts when no bytes
 * arrive for that long (header phase or between chunks), and each received
 * chunk resets the window — so large, slow page images are not aborted mid-body
 * and retried from byte zero. Falls back to a single arrayBuffer read when the
 * response exposes no readable stream.
 */
export async function fetchBufferStreaming(
  url: string,
  init: RequestInit = {},
  handlers: StreamProgressHandlers = {},
  timeoutMs = 30_000,
): Promise<Buffer> {
  const controller = new AbortController();
  let timer = setTimeout(() => controller.abort(), timeoutMs);
  const armTimer = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), timeoutMs);
  };
  try {
    const res = await fetch(url, { ...init, signal: controller.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
    armTimer(); // headers received — start the idle window for the body
    const lengthHeader = res.headers.get('content-length');
    const totalBytes = lengthHeader ? Number(lengthHeader) || null : null;
    handlers.onAttemptStart?.();

    interface StreamReader {
      read(): Promise<{ done: boolean; value?: Uint8Array }>;
    }
    const body = res.body as unknown as { getReader?: () => StreamReader } | null;
    if (body && typeof body.getReader === 'function') {
      const reader = body.getReader();
      const chunks: Buffer[] = [];
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          armTimer(); // bytes arrived — reset the idle window
          const buf = Buffer.from(value);
          chunks.push(buf);
          received += buf.length;
          handlers.onProgress?.(received, totalBytes);
        }
      }
      return Buffer.concat(chunks);
    }

    const buf = Buffer.from(await res.arrayBuffer());
    handlers.onProgress?.(buf.length, totalBytes ?? buf.length);
    return buf;
  } finally {
    clearTimeout(timer);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Retry helper with exponential backoff. */
export async function retry<T>(
  fn: () => Promise<T>,
  attempts = 3,
  baseDelayMs = 500,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        await sleep(baseDelayMs * 2 ** i);
      }
    }
  }
  throw lastErr;
}
