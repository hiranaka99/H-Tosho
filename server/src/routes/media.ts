import { Hono } from 'hono';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from '../db/index.js';
import { mapLimit } from '../lib/http.js';
import { refreshHitomiImageUrl } from '../downloader/hitomi.js';
import { detectImageFormat } from '../downloader/ehentaiClient.js';
import { ehentaiPreviewBytes, isEhentaiViewerUrl } from '../downloader/ehentai.js';

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

/** In-memory LRU cache of proxied image bytes so repeated renders don't re-fetch the CDN. */
const cache = new Map<string, { at: number; type: string; buf: Buffer }>();
let cacheBytes = 0;
const inflight = new Map<string, Promise<MediaResult>>();
const CACHE_TTL_MS = 60 * 60_000; // covers are stable once a gallery exists
/** Cache holds realistic cover sizes only (a few MB at most per file). */
const CACHE_MAX = 100;
const CACHE_MAX_BYTES = 2 * 1024 * 1024;
const CACHE_TOTAL_MAX_BYTES = 64 * 1024 * 1024;
/** Hard cap on any single proxied response (covers never approach this). */
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
/** Max redirect hops followed (each hop is re-validated against the allowlist). */
const MAX_REDIRECTS = 5;
const UPSTREAM_TIMEOUT_MS = 20_000;
// Disk layer under the data dir so cover bytes survive restarts and hold far
// more entries than memory. Covers are immutable once a gallery exists, so
// the TTL is long; eviction is by mtime when the file count exceeds the cap.
const MEDIA_CACHE_DIR = path.join(DATA_DIR, 'media-cache');
const DISK_TTL_MS = 7 * 24 * 60 * 60_000;
const DISK_MAX_FILES = 400;
let mediaCacheDirReady = false;
let diskWritesSinceEvict = 0;
let lastDiskEvictAt = 0;
let diskEvictRunning: Promise<void> | null = null;

/**
 * Hosts allowed as /media targets. A target host matches when it equals an
 * entry or is a subdomain of one. Exact-name matching keeps this a closed set:
 * IP literals, other CDNs, and internal service names all fail.
 */
const ALLOWED_HOSTS = ['uploads.mangadex.org', 'gold-usergeneratedcontent.net'];
const NHENTAI_CDN_HOST = /^[it]\d+\.nhentai\.net$/i;
/** E-Hentai cover CDN hosts (hotlink-protected: they need a family Referer). */
const EH_COVER_HOSTS = new Set(['ehgt.org', 't1.e-hentai.org', 't2.e-hentai.org', 't3.e-hentai.org', 'ehgt.e-hentai.org']);

function isEhentaiCoverHost(hostname: string): boolean {
  return EH_COVER_HOSTS.has(hostname.toLowerCase());
}

function isAllowedHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (!h || h.includes(':')) return false; // reject empty and IPv6-literal hosts
  if (EH_COVER_HOSTS.has(h)) return true;
  // Family hosts are only admitted for well-formed viewer references; the
  // route resolves those server-side and never fetches them generically.
  if (h === 'e-hentai.org' || h === 'exhentai.org') return true;
  return ALLOWED_HOSTS.some((a) => h === a || h.endsWith('.' + a)) || NHENTAI_CDN_HOST.test(h);
}

function isHttpUrl(u: URL): boolean {
  return u.protocol === 'https:' || u.protocol === 'http:';
}

function getCached(key: string): { type: string; buf: Buffer } | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    cacheBytes -= hit.buf.length;
    return null;
  }
  // Promote to MRU.
  cache.delete(key);
  cache.set(key, hit);
  return { type: hit.type, buf: hit.buf };
}

function setCached(key: string, type: string, buf: Buffer): void {
  if (buf.length > CACHE_MAX_BYTES) return;
  const existing = cache.get(key);
  if (existing) {
    cache.delete(key);
    cacheBytes -= existing.buf.length;
  }
  while (cache.size >= CACHE_MAX || (cacheBytes + buf.length > CACHE_TOTAL_MAX_BYTES && cache.size > 0)) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    const oldest = cache.get(oldestKey);
    cache.delete(oldestKey);
    if (oldest) cacheBytes -= oldest.buf.length;
  }
  cache.set(key, { at: Date.now(), type, buf });
  cacheBytes += buf.length;
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

async function evictDiskCache(): Promise<void> {
  if (diskEvictRunning) return diskEvictRunning;
  diskEvictRunning = (async () => {
    try {
      const entries = await fs.readdir(MEDIA_CACHE_DIR);
      const dataFiles = entries.filter((e) => !e.endsWith('.type') && !e.endsWith('.tmp'));
      if (dataFiles.length <= DISK_MAX_FILES) return;
      const stamped = (await mapLimit(dataFiles, 16, async (name) => {
        try {
          const st = await fs.stat(path.join(MEDIA_CACHE_DIR, name));
          return { name, mtime: st.mtimeMs };
        } catch {
          return null;
        }
      })).filter((entry): entry is { name: string; mtime: number } => entry !== null);
      stamped.sort((a, b) => a.mtime - b.mtime);
      const excess = stamped.slice(0, Math.max(0, stamped.length - DISK_MAX_FILES));
      await mapLimit(excess, 16, async (old) => {
        await fs.rm(path.join(MEDIA_CACHE_DIR, old.name), { force: true });
        await fs.rm(path.join(MEDIA_CACHE_DIR, old.name + '.type'), { force: true });
      });
    } catch {
      /* disk cache eviction is best-effort */
    } finally {
      lastDiskEvictAt = Date.now();
      diskWritesSinceEvict = 0;
      diskEvictRunning = null;
    }
  })();
  return diskEvictRunning;
}

/** L2 store (best-effort): write bytes + content-type atomically, evict oldest lazily. */
async function setDisk(key: string, type: string, buf: Buffer): Promise<void> {
  if (buf.length > CACHE_MAX_BYTES) return;
  try {
    if (!mediaCacheDirReady) {
      await fs.mkdir(MEDIA_CACHE_DIR, { recursive: true });
      mediaCacheDirReady = true;
    }
    const file = diskFile(key);
    const suffix = `.${randomUUID()}.tmp`;
    await Promise.all([
      fs.writeFile(file + suffix, buf).then(() => fs.rename(file + suffix, file)),
      fs.writeFile(file + '.type' + suffix, type).then(() => fs.rename(file + '.type' + suffix, file + '.type')),
    ]);
    diskWritesSinceEvict += 1;
    if (!diskEvictRunning && (diskWritesSinceEvict >= 16 || Date.now() - lastDiskEvictAt >= 30_000)) {
      void evictDiskCache();
    }
  } catch {
    mediaCacheDirReady = false;
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
  if (NHENTAI_CDN_HOST.test(hostname)) return 'https://nhentai.net/';
  if (isEhentaiCoverHost(hostname)) return 'https://e-hentai.org/';
  return 'https://hitomi.la/';
}

/** Fetch headers for one hop, based on that hop's host. */
function hopHeaders(hostname: string): Record<string, string> {
  const referer = refererForHost(hostname);
  return {
    // MangaDex challenges browser identities with HTTP 403. Identify our
    // server as an application so public cover downloads remain accessible.
    'User-Agent': hostname === 'uploads.mangadex.org'
      ? 'H-Tosho/1.0'
      : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 H-Tosho/1.0',
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
    const res = await fetch(current, { headers: hopHeaders(current.hostname), redirect: 'manual', signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc || hop >= MAX_REDIRECTS) throw new Error('Too many redirects');
      const next = new URL(loc, current);
      if (!isHttpUrl(next) || !isAllowedHost(next.hostname)) throw new Error('Redirect to disallowed host');
      if ((next.hostname === 'e-hentai.org' || next.hostname === 'exhentai.org') && !isEhentaiViewerUrl(next)) throw new Error('Redirect to disallowed host');
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

type MediaResult = { ok: true; type: string; buf: Buffer } | { ok: false; status: 400 | 502; error: string };

/** Parse and allowlist-check a proxy target; null when it must not be fetched. */
function validTarget(target: string | null): URL | null {
  if (!target) return null;
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return null;
  }
  if (!isHttpUrl(parsed) || !isAllowedHost(parsed.hostname)) return null;
  // Family hosts are only ever served as viewer references (resolved
  // server-side below); any other family path is rejected, not proxied.
  if ((parsed.hostname === 'e-hentai.org' || parsed.hostname === 'exhentai.org') && !isEhentaiViewerUrl(parsed)) return null;
  return parsed;
}

/** Resolve one proxy target through the memory → disk → upstream layers. */
async function loadMedia(target: string, parsed: URL): Promise<MediaResult> {
  const cached = getCached(target);
  if (cached) return { ok: true, ...cached };

  const existing = inflight.get(target);
  if (existing) return existing;

  const promise = loadMediaUncached(target, parsed).finally(() => {
    if (inflight.get(target) === promise) inflight.delete(target);
  });
  inflight.set(target, promise);
  return promise;
}

async function loadMediaUncached(target: string, parsed: URL): Promise<MediaResult> {
  const onDisk = await getFromDisk(target);
  if (onDisk) {
    setCached(target, onDisk.type, onDisk.buf); // promote to L1
    return { ok: true, ...onDisk };
  }

  // E-Hentai viewer refs never go through the generic fetch: they are
  // resolved server-side (session + gate + pinned IP) and the image bytes
  // come only from the URL the viewer page itself exposed, so a quota or
  // denial page can never be published as an image.
  if (isEhentaiViewerUrl(parsed)) {
    let out: { buf: Buffer; type: string };
    try {
      out = await ehentaiPreviewBytes(target);
    } catch (error) {
      return { ok: false, status: 502, error: error instanceof Error ? error.message : 'E-Hentai preview unavailable' };
    }
    if (out.buf.length > MAX_DOWNLOAD_BYTES) return { ok: false, status: 502, error: 'Response too large' };
    setCached(target, out.type, out.buf);
    void setDisk(target, out.type, out.buf);
    return { ok: true, ...out };
  }

  let res: Response;
  try {
    res = await fetchWithValidatedRedirects(parsed);
    // Hitomi cover URLs embed a routing prefix from gg.js that rotates every
    // few minutes. Recommendation sets are cached for a day, so rebuild a
    // stale URL on demand instead of returning a broken cover.
    if (!res.ok && parsed.hostname.endsWith('.gold-usergeneratedcontent.net')) {
      const refreshed = await refreshHitomiImageUrl(parsed.href);
      if (refreshed && refreshed !== parsed.href) {
        const next = new URL(refreshed);
        if (isAllowedHost(next.hostname)) res = await fetchWithValidatedRedirects(next);
      }
    }
  } catch {
    return { ok: false, status: 502, error: 'Upstream fetch failed' };
  }

  if (!res.ok) return { ok: false, status: 502, error: `Upstream returned HTTP ${res.status}` };

  let buf: Buffer;
  try {
    buf = await readBodyWithCap(res, MAX_DOWNLOAD_BYTES);
  } catch {
    return { ok: false, status: 502, error: 'Response too large' };
  }

  let type = res.headers.get('content-type') || 'image/jpeg';
  if (isEhentaiCoverHost(parsed.hostname)) {
    // E-Hentai serves quota/denial HTML with image content types under
    // load: trust only the bytes, never the header.
    const format = detectImageFormat(buf);
    if (!format) return { ok: false, status: 502, error: 'Upstream did not return an image' };
    type = format === 'jpg' ? 'image/jpeg' : format === 'png' ? 'image/png' : format === 'gif' ? 'image/gif' : 'image/webp';
  }
  setCached(target, type, buf);
  void setDisk(target, type, buf);
  return { ok: true, type, buf };
}

/**
 * Warm the cover cache for absolute CDN URLs (e.g. the daily recommendation
 * covers) so the first page view is served from disk instead of the CDN.
 * Best-effort: disallowed URLs are skipped. Returns how many failed to load.
 */
export async function prefetchMedia(urls: Iterable<string>, concurrency = 4): Promise<{ loaded: number; failed: number }> {
  const targets = [...new Set(urls)].map((url) => ({ url, parsed: validTarget(url) }))
    .filter((t): t is { url: string; parsed: URL } => t.parsed !== null);
  const results = await mapLimit(targets, concurrency, ({ url, parsed }) => loadMedia(url, parsed).then((r) => r.ok, () => false));
  const loaded = results.filter(Boolean).length;
  return { loaded, failed: results.length - loaded };
}

export function mediaRouter(): Hono {
  const r = new Hono();

  r.get('/media', async (c) => {
    const target = decodeUrlParam(c.req.query('u'));
    const parsed = validTarget(target);
    if (!target || !parsed) return c.json({ error: 'Invalid media URL' }, 400);
    const result = await loadMedia(target, parsed);
    if (!result.ok) return c.json({ error: result.error }, result.status);
    const buffer = result.buf.buffer;
    const bytes = buffer instanceof ArrayBuffer
      ? new Uint8Array(buffer, result.buf.byteOffset, result.buf.byteLength)
      : Uint8Array.from(result.buf);
    return c.body(bytes, 200, {
      'Content-Type': result.type,
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

/** Rewrite hitomi/E-Hentai cover URLs to route through the proxy (other
 *  sources are untouched). */
export function rewriteDoujinCover<T extends { source?: string; coverUrl?: string | null }>(r: T): T {
  if (r.source === 'hitomi' && typeof r.coverUrl === 'string' && r.coverUrl.startsWith('http')) {
    return { ...r, coverUrl: mediaProxyUrl(r.coverUrl) };
  }
  if (r.source === 'ehentai' && typeof r.coverUrl === 'string' && r.coverUrl.startsWith('http')) {
    try {
      if (isEhentaiCoverHost(new URL(r.coverUrl).hostname)) return { ...r, coverUrl: mediaProxyUrl(r.coverUrl) };
    } catch {
      /* unparseable cover: leave as-is */
    }
  }
  return r;
}

/** Convert provider-resolved pages into authenticated same-origin preview URLs. */
export function rewriteDoujinPages(pages: string[], fallbacks?: (string | null)[]): { previewPages: string[]; previewFallbacks: (string | null)[] } {
  return {
    previewPages: pages.map(mediaProxyUrl),
    previewFallbacks: pages.map((_, index) => fallbacks?.[index] ? mediaProxyUrl(fallbacks[index] as string) : null),
  };
}

/** Rewrite MangaDex CDN cover URLs to route through the proxy (other URLs are untouched). */
export function rewriteMangaDexCoverUrl(url?: string | null): string | undefined {
  if (typeof url === 'string' && url.startsWith('https://uploads.mangadex.org/covers/')) {
    return mediaProxyUrl(url);
  }
  return url ?? undefined;
}
