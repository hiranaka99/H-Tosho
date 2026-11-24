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

/**
 * Raster types the proxy may serve. Everything it returns is same-origin, so
 * an upstream answering with HTML or SVG must never pass through: that would
 * run script on the app's origin with the viewer's session.
 */
const SAFE_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif', 'image/jxl', 'image/heic', 'image/heif', 'image/bmp']);

/** Identify a raster image from its leading bytes (null when unrecognized). */
function sniffImageType(buf: Buffer): string | null {
  const format = detectImageFormat(buf);
  if (format) return format === 'jpg' ? 'image/jpeg' : format === 'png' ? 'image/png' : format === 'gif' ? 'image/gif' : 'image/webp';
  if (buf.length >= 12 && buf.toString('latin1', 4, 8) === 'ftyp') {
    const brand = buf.toString('latin1', 8, 12);
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
    if (brand === 'heic' || brand === 'heix' || brand === 'hevc' || brand === 'heim' || brand === 'heis') return 'image/heic';
    if (brand === 'mif1' || brand === 'msf1') return 'image/heif';
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0x0a) return 'image/jxl';
  if (buf.length >= 12 && buf.readUInt32BE(0) === 0x0c && buf.toString('latin1', 4, 8) === 'JXL ') return 'image/jxl';
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp';
  return null;
}

/**
 * The content type to serve for proxied bytes: a declared raster type is
 * kept (served with nosniff, so it can never be reinterpreted); anything else
 * — HTML, SVG, missing — is replaced by the sniffed format or rejected.
 */
export function safeMediaType(declared: string | null | undefined, buf: Buffer): string | null {
  const base = (declared ?? '').split(';', 1)[0].trim().toLowerCase();
  if (SAFE_IMAGE_TYPES.has(base)) return base;
  return sniffImageType(buf);
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

/** Hitomi image CDN hosts (`a1.`, `w2.`, `3.`, …) — not thumbnail hosts like `tn.`. */
const HITOMI_IMAGE_HOST = /^[aw]?\d*\.gold-usergeneratedcontent\.net$/i;
const HITOMI_IMAGE_PATH = /\/([0-9a-f]{64})\.([a-z0-9]{2,5})$/i;

/**
 * Cache identity for a proxy target. Hitomi image URLs embed gg.js's rotating
 * base-path prefix (and a routing subdomain), so the same `<hash>.<ext>` image
 * appears under many URLs over a day; keying on the content hash keeps the
 * L1/L2 caches effective across rotations. Everything else keys on the URL.
 */
function mediaCacheKey(target: string, parsed: URL): string {
  if (HITOMI_IMAGE_HOST.test(parsed.hostname)) {
    const match = HITOMI_IMAGE_PATH.exec(parsed.pathname);
    if (match) return `hitomi:${match[1].toLowerCase()}.${match[2].toLowerCase()}`;
  }
  return target;
}

function diskFile(key: string): string {
  return path.join(MEDIA_CACHE_DIR, createHash('sha256').update(key, 'utf8').digest('hex'));
}

/** Skip access-time bumps for entries touched within this window. */
const DISK_TOUCH_INTERVAL_MS = 60_000;

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
    // Record the access (atime only: mtime stays the write time that drives
    // the TTL) so eviction drops the least recently used entries, not merely
    // the oldest written. Fire-and-forget; explicit utimes works even on
    // noatime mounts.
    if (Date.now() - st.atimeMs > DISK_TOUCH_INTERVAL_MS) {
      void fs.utimes(file, new Date(), st.mtime).catch(() => undefined);
    }
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
          // Last access (bumped on L2 hits) or write, whichever is newer.
          return { name, mtime: Math.max(st.atimeMs, st.mtimeMs) };
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
      discardBody(res);
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

/** Release an unread response body so undici can reuse the connection. */
function discardBody(res: Response): void {
  void res.body?.cancel().catch(() => undefined);
}

/** Read a response body into a Buffer, throwing once the byte cap is exceeded. */
async function readBodyWithCap(res: Response, maxBytes: number): Promise<Buffer> {
  const body = res.body as unknown as { getReader?: () => { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel?: () => Promise<unknown> } } | null;
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    const chunks: Buffer[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        received += value.byteLength;
        if (received > maxBytes) {
          void reader.cancel?.().catch(() => undefined);
          throw new Error('Response exceeds size cap');
        }
        // Zero-copy view; the single concat below is the only copy.
        chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
      }
    }
    // Always concat (even a single chunk) so a cached entry never pins a
    // larger pooled upstream ArrayBuffer.
    return Buffer.concat(chunks, received);
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
  const key = mediaCacheKey(target, parsed);
  const cached = getCached(key);
  if (cached) return { ok: true, ...cached };

  const existing = inflight.get(key);
  if (existing) return existing;

  const promise = loadMediaUncached(key, target, parsed).finally(() => {
    if (inflight.get(key) === promise) inflight.delete(key);
  });
  inflight.set(key, promise);
  return promise;
}

async function loadMediaUncached(key: string, target: string, parsed: URL): Promise<MediaResult> {
  const onDisk = await getFromDisk(key);
  if (onDisk) {
    setCached(key, onDisk.type, onDisk.buf); // promote to L1
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
    setCached(key, out.type, out.buf);
    void setDisk(key, out.type, out.buf);
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
        if (isAllowedHost(next.hostname)) {
          discardBody(res);
          res = await fetchWithValidatedRedirects(next);
        }
      }
    }
  } catch {
    return { ok: false, status: 502, error: 'Upstream fetch failed' };
  }

  if (!res.ok) {
    discardBody(res);
    return { ok: false, status: 502, error: `Upstream returned HTTP ${res.status}` };
  }

  let buf: Buffer;
  try {
    buf = await readBodyWithCap(res, MAX_DOWNLOAD_BYTES);
  } catch {
    return { ok: false, status: 502, error: 'Response too large' };
  }

  // E-Hentai serves quota/denial HTML with image content types under load:
  // trust only its bytes, never the header. Other CDNs keep a declared raster
  // type; non-image types are sniffed or rejected (see safeMediaType).
  const type = isEhentaiCoverHost(parsed.hostname) ? sniffImageType(buf) : safeMediaType(res.headers.get('content-type'), buf);
  if (!type) return { ok: false, status: 502, error: 'Upstream did not return an image' };
  setCached(key, type, buf);
  void setDisk(key, type, buf);
  return { ok: true, type, buf };
}

/** Weak validators per served buffer (L1 hits return the same Buffer object). */
const etags = new WeakMap<Buffer, string>();

function weakEtag(buf: Buffer): string {
  let tag = etags.get(buf);
  if (!tag) {
    tag = `W/"${buf.length.toString(36)}-${createHash('sha1').update(buf).digest('base64url').slice(0, 22)}"`;
    etags.set(buf, tag);
  }
  return tag;
}

/** If-None-Match comparison (weak, per RFC 9110 §13.1.2). */
function etagMatches(header: string | undefined, tag: string): boolean {
  if (!header) return false;
  const bare = tag.replace(/^W\//, '');
  return header.split(',').some((candidate) => {
    const value = candidate.trim();
    return value === '*' || value.replace(/^W\//, '') === bare;
  });
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
    // Re-checked on every response: disk-cache entries written by older
    // builds may carry an unvalidated upstream type.
    const type = safeMediaType(result.type, result.buf);
    if (!type) return c.json({ error: 'Upstream did not return an image' }, 502);
    const etag = weakEtag(result.buf);
    const headers = {
      'Cache-Control': 'private, max-age=3600',
      ETag: etag,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    };
    if (etagMatches(c.req.header('if-none-match'), etag)) return c.body(null, 304, headers);
    const buffer = result.buf.buffer;
    const bytes = buffer instanceof ArrayBuffer
      ? new Uint8Array(buffer, result.buf.byteOffset, result.buf.byteLength)
      : Uint8Array.from(result.buf);
    return c.body(bytes, 200, { 'Content-Type': type, ...headers });
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
