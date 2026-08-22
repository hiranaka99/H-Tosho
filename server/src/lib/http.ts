/**
 * Small shared HTTP helpers for outbound calls to providers & Kavita.
 */

export interface HttpResponse<T = unknown> {
  status: number;
  data: T;
}

export async function fetchJson<T = unknown>(
  url: string,
  init: RequestInit = {},
  timeoutMs = 15_000,
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
 * byte-level progress. Falls back to a single arrayBuffer read when the
 * response exposes no readable stream.
 */
export async function fetchBufferStreaming(
  url: string,
  init: RequestInit = {},
  handlers: StreamProgressHandlers = {},
  timeoutMs = 30_000,
): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
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