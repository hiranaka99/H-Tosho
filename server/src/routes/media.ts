import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from '../db/index.js';

/**
 * Media proxy for CDN cover images that browsers cannot load directly.
 *
 * Hitomi's image CDN (`gold-usergeneratedcontent.net`) rejects requests that do
 * not carry a `hitomi.la` Referer (it answers 404). MangaDex's cover CDN
 * (`uploads.mangadex.org`) does the opposite: it answers third-party Referers
 * (anything other than mangadex.org or the literal hostname "localhost") with
 * a placeholder promo card instead of the cover — including 127.0.0.1 and LAN
 * addresses, so the app only renders covers when opened via http://localhost.
 * Browsers cannot attach (or omit) such Referers on cross-origin `<img>` loads,
 * so these images are proxied through the server, which fetches them with the
 * headers each CDN requires and streams the bytes back to the client.
 *
 * The target URL is passed base64url-encoded as `?u=` so arbitrary CDN paths
 * (which include slashes) survive query-string encoding without ambiguity:
 *   GET /media?u=<base64url(https://a2.gold-usergeneratedcontent.net/...avif)>
 *
 * Security: the proxy is an SSRF surface by construction (the server fetches a
 * caller-supplied URL). Targets are therefore restricted to an explicit host
 * allowlist (the two CDNs above), IP literals are rejected, and every redirect
 * hop is re-validated against the allowlist. Response bodies are capped so a
 * hostile or misbehaving upstream cannot pin unbounded memory.
 */

/** In-memory cache of proxied image bytes so repeated renders don't re-fetch the CDN. */
const cache = new Map<string, { at: number; type: string; buf: Buffer }>();
const CACHE_TTL_MS = 60 * 60_000; // covers are stable once a gallery exists
/** Cache holds realistic cover sizes only (a few MB at most per file). */
const CACHE_MAX = 100;
const CACHE_MAX_BYTES = 2 * 1024 * 1024;
/** Hard cap on any single proxied response (covers never approach this). */
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
/** Max redirect hops followed (each hop is re-validated against the allowlist). */
const MAX_REDIRECTS = 5;
// Disk layer under the data dir so cover bytes survive restarts and hold far
// more entries than memory. Covers are immutable once a gallery exists, so
// the TTL is long; eviction is by mtime when the file count exceeds the cap.
const MEDIA_CACHE_DIR = path.join(DATA_DIR, 'media-cache');
const DISK_TTL_MS = 7 * 24 * 60 * 60_000;
const DISK_MAX_FILES = 400;

/**
 * Hosts allowed as /media targets. A target host matches when it equals an
 * entry or is a subdomain of one. Exact-name matching keeps this a closed set:
 * IP literals, other CDNs, and internal service names all fail.
 */
const ALLOWED_HOSTS = ['uploads.mangadex.org', 'gold-usergeneratedcontent.net'];

function isAllowedHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (!h || h.includes(':')) return false; // reject empty and IPv6-literal hosts
  return ALLOWED_HOSTS.some((a) => h === a || h.endsWith('.' + a));
}

function isHttpUrl(u: URL): boolean {
  return u.protocol === 'https:' || u.protocol === 'http:';
}

function getCached(key: string): { type: string; buf: Buffer } | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return { type: hit.type, buf: hit.buf };
}

function setCached(key: string, type: string, buf: Buffer): void {
  if (buf.length > CACHE_MAX_BYTES) return;
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { at: Date.now(), type, buf });
}

function diskFile(key: string): string {
  return path.join(MEDIA_CACHE_DIR, createHash('sha256').update(key, 'utf8').digest('hex'));
}

/** L2 lookup: read a cached cover from disk (missing/expired → null). */
async function getFromDisk(key: string): Promise<{ type: string; buf: Buffer } | null> {
  const file = diskFile(key);
  try {
    const st = await fs.stat(file);
    if (Date.now() - st.mtimeMs > DISK_TTL_MS) {
      await fs.rm(file, { force: true });
      await fs.rm(file + '.type', { force: true });
      return null;
    }
    const [buf, typeRaw] = await Promise.all([
      fs.readFile(file),
      fs.readFile(file + '.type', 'utf8').catch(() => ''),
    ]);
    return { type: typeRaw.trim() || 'image/jpeg', buf };
  } catch {
    return null;
  }
}

/** L2 store (best-effort): write bytes + content-type, evict oldest beyond the cap. */
async function setDisk(key: string, type: string, buf: Buffer): Promise<void> {
  if (buf.length > CACHE_MAX_BYTES) return;
  try {
    await fs.mkdir(MEDIA_CACHE_DIR, { recursive: true });
    const file = diskFile(key);
    await fs.writeFile(file, buf);
    await fs.writeFile(file + '.type', type);
    const entries = await fs.readdir(MEDIA_CACHE_DIR);
    const dataFiles = entries.filter((e) => !e.endsWith('.type'));
    if (dataFiles.length <= DISK_MAX_FILES) return;
    const stamped: { name: string; mtime: number }[] = [];
    for (const name of dataFiles) {
      try {
        const st = await fs.stat(path.join(MEDIA_CACHE_DIR, name));
        stamped.push({ name, mtime: st.mtimeMs });
      } catch {
        /* raced away — skip */
      }
    }
    stamped.sort((a, b) => a.mtime - b.mtime);
    for (const old of stamped.slice(0, dataFiles.length - DISK_MAX_FILES)) {
      await fs.rm(path.join(MEDIA_CACHE_DIR, old.name), { force: true });
      await fs.rm(path.join(MEDIA_CACHE_DIR, old.name + '.type'), { force: true });
    }
  } catch {
    /* disk cache is best-effort; never fail a proxied request over it */
  }
}

/** Decode a base64url query value back to a string. */
function decodeUrlParam(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const b64 = value.replace(/-/g, '+').replace(/_/g, '/');
    return Buffer.from(b64, 'base64').toString('utf8') || null;
  } catch {
    return null;
  }
}

/**
 * Per-host Referer policy for proxied fetches. `undefined` means send no
 * Referer at all — required for MangaDex, whose CDN serves a placeholder card
 * to any third-party Referer (including 127.0.0.1 / LAN origins).
 */
function refererForHost(hostname: string): string | undefined {
  if (hostname === 'uploads.mangadex.org') return undefined;
  // Hitomi's CDN requires a hitomi.la Referer; the header is harmless for other hosts.
  return 'https://hitomi.la/';
}

/** Fetch headers for one hop, based on that hop's host. */
function hopHeaders(hostname: string): Record<string, string> {
  const referer = refererForHost(hostname);
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 H-Tosho/1.0',
    ...(referer ? { Referer: referer } : {}),
    Accept: 'image/avif,image/webp,image/png,image/jpeg,*/*;q=0.8',
  };
}

/**
 * Follow redirects manually, re-validating every hop's target against the
 * allowlist (a redirect from an allowed CDN to an internal host must not be
 * followed). Throws on disallowed targets or when the hop budget is exceeded.
 */
async function fetchWithValidatedRedirects(start: URL): Promise<Response> {
  let current = start;
  for (let hop = 0; ; hop++) {
    const res = await fetch(current, { headers: hopHeaders(current.hostname), redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc || hop >= MAX_REDIRECTS) throw new Error('Too many redirects');
      const next = new URL(loc, current);
      if (!isHttpUrl(next) || !isAllowedHost(next.hostname)) throw new Error('Redirect to disallowed host');
      current = next;
      continue;
    }
    return res;
  }
}

/** Read a response body into a Buffer, throwing once the byte cap is exceeded. */
async function readBodyWithCap(res: Response, maxBytes: number): Promise<Buffer> {
  const body = res.body as unknown as { getReader?: () => { read(): Promise<{ done: boolean; value?: Uint8Array }> } } | null;
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    const chunks: Buffer[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        const buf = Buffer.from(value);
        received += buf.length;
        if (received > maxBytes) throw new Error('Response exceeds size cap');
        chunks.push(buf);
      }
    }
    return Buffer.concat(chunks);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) throw new Error('Response exceeds size cap');
  return buf;
}

export function mediaRouter(): Hono {
  const r = new Hono();
  r.use('*', cors());

  r.get('/media', async (c) => {
    const target = decodeUrlParam(c.req.query('u'));
    let parsed: URL | null = null;
    if (target) {
      try {
        parsed = new URL(target);
      } catch {
        parsed = null;
      }
    }
    if (!parsed || !isHttpUrl(parsed) || !isAllowedHost(parsed.hostname)) {
      return c.json({ error: 'Invalid media URL' }, 400);
    }

    const cached = getCached(target as string);
    if (cached) {
      return c.body(new Uint8Array(cached.buf), 200, {
        'Content-Type': cached.type,
        'Cache-Control': 'private, max-age=3600',
      });
    }

    const onDisk = await getFromDisk(target as string);
    if (onDisk) {
      setCached(target as string, onDisk.type, onDisk.buf); // promote to L1
      return c.body(new Uint8Array(onDisk.buf), 200, {
        'Content-Type': onDisk.type,
        'Cache-Control': 'private, max-age=3600',
      });
    }

    let res: Response;
    try {
      res = await fetchWithValidatedRedirects(parsed);
    } catch {
      return c.json({ error: 'Upstream fetch failed' }, 502);
    }

    if (!res.ok) {
      return c.json({ error: `Upstream returned HTTP ${res.status}` }, 502);
    }

    let buf: Buffer;
    try {
      buf = await readBodyWithCap(res, MAX_DOWNLOAD_BYTES);
    } catch {
      return c.json({ error: 'Response too large' }, 502);
    }

    const type = res.headers.get('content-type') || 'image/jpeg';
    setCached(target as string, type, buf);
    void setDisk(target as string, type, buf);
    return c.body(new Uint8Array(buf), 200, {
      'Content-Type': type,
      'Cache-Control': 'private, max-age=3600',
    });
  });

  return r;
}

/** Wrap an absolute image URL in a same-origin `/media` proxy URL (base64url-encoded). */
export function mediaProxyUrl(url: string): string {
  const b64 = Buffer.from(url, 'utf8').toString('base64url');
  return `/media?u=${b64}`;
}

/** Rewrite hitomi cover URLs to route through the proxy (other sources are untouched). */
export function rewriteHitomiCover<T extends { source?: string; coverUrl?: string | null }>(r: T): T {
  if (r.source === 'hitomi' && typeof r.coverUrl === 'string' && r.coverUrl.startsWith('http')) {
    return { ...r, coverUrl: mediaProxyUrl(r.coverUrl) };
  }
  return r;
}

/** Rewrite MangaDex CDN cover URLs to route through the proxy (other URLs are untouched). */
export function rewriteMangaDexCoverUrl(url?: string | null): string | undefined {
  if (typeof url === 'string' && url.startsWith('https://uploads.mangadex.org/covers/')) {
    return mediaProxyUrl(url);
  }
  return url ?? undefined;
}
