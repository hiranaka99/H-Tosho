/**
 * Bounded E-Hentai family HTTP client, shared by account tests, search,
 * metadata, page resolution, previews, and downloads.
 *
 * Security properties:
 * - Forum/session cookies are sent only to the exact authorized family site;
 *   never to the metadata API host, thumbnail/CDN hosts, or image hosts.
 * - Redirects are followed manually; every hop is re-validated against the
 *   lane's host policy and credentials are rebuilt per target, never
 *   forwarded cross-host.
 * - Image byte transfers validate DNS results and pin the connection to a
 *   validated address (core https), so a validate-then-refetch DNS-rebinding
 *   gap cannot reach private ranges.
 * - Responses are classified, not trusted: HTTP 200 denial/placeholder/quota
 *   pages are rejected by marker and content-type checks, never published as
 *   content.
 *
 * The client takes a session explicitly; it never reads stored credentials
 * itself, so draft sessions can be tested without saving.
 */

import dns from 'node:dns';
import https from 'node:https';
import fs from 'node:fs/promises';
import { getEhentaiGate, RequestAbortedError } from './ehentaiGate.js';
import { parseRetryAfterMs } from '../lib/http.js';
import { ehentaiHost, type EhentaiSite } from '../contracts/doujin.js';
import { onEhentaiAccountChange, getAccountRevision } from '../services/ehentaiAccount.js';
import type { EhentaiSessionInput } from '../contracts/ehentai.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 H-Tosho/1.0';

/** Static (non-viewer) image hosts owned by the E-Hentai family. Viewer
 *  (H@H) hosts are approved per gallery from the authorized viewer page. */
const STATIC_IMAGE_HOSTS = new Set(['ehgt.org', 't1.e-hentai.org', 't2.e-hentai.org', 't3.e-hentai.org', 'ehgt.e-hentai.org', 'i0.hathost.com', 'i1.hathost.com', 'i2.hathost.com', 'i3.hathost.com', 'i4.hathost.com', 'i5.hathost.com', 'i6.hathost.com', 'i7.hathost.com']);
const API_HOST = 'api.e-hentai.org';
const MAX_REDIRECTS = 5;
const HTML_BODY_CAP = 2 * 1024 * 1024;
const API_BODY_CAP = 4 * 1024 * 1024;

export type EhentaiFailureKind =
  | 'quota' // image/gallery quota exhausted (HTTP 509 class)
  | 'denied' // access denied (invalid session, no ExHentai right, denial page)
  | 'unavailable' // upstream unreachable or unexpected response
  | 'rate-limited' // 429 / paced out
  | 'blocked' // SSRF/redirect policy rejected the target
  | 'parse' // unexpected response shape
  | 'timeout';

/** Typed upstream failure. The message is safe to surface to the user: no
 *  cookies, query strings, or upstream bodies. */
export class EhentaiUpstreamError extends Error {
  constructor(
    message: string,
    public readonly kind: EhentaiFailureKind,
    public readonly status: number | null = null,
    public readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'EhentaiUpstreamError';
  }
}

// ---------------- cookie scoping ----------------

/** The exact Cookie header for one family host. The metadata API and image
 *  hosts never receive forum cookies. */
export function buildEhentaiCookies(session: EhentaiSessionInput | null | undefined, site: EhentaiSite): string | null {
  if (!session) return null;
  const pairs = [`ipb_member_id=${session.ipb_member_id}`, `ipb_pass_hash=${session.ipb_pass_hash}`];
  if (site === 'exhentai' && session.igneous) pairs.push(`igneous=${session.igneous}`);
  return pairs.join('; ');
}

// ---------------- SSRF / address validation ----------------

function ipv4Parts(ip: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const parts = m.slice(1).map((p) => Number(p));
  return parts.every((p) => Number.isInteger(p) && p >= 0 && p <= 255) ? parts : null;
}

function ipv4ToNumber(parts: number[]): number {
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

/** Unwrap an IPv6-mapped IPv4 address (::ffff:1.2.3.4) to its v4 form. */
function unwrapMappedV6(ip: string): string | null {
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  return m ? m[1] : null;
}

/** True when an address is public internet space. Private, loopback,
 *  link-local (incl. cloud metadata), CGNAT, and unspecified are rejected. */
export function isPublicAddress(ip: string): boolean {
  const v6 = ip.includes(':');
  if (!v6) {
    const parts = ipv4Parts(ip);
    if (!parts) return false;
    const n = ipv4ToNumber(parts);
    const inRange = (base: string, bits: number): boolean => {
      const b = ipv4ToNumber(ipv4Parts(base)!);
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      return (n & mask) === (b & mask);
    };
    if (parts[0] === 0) return false; // 0.0.0.0/8
    if (inRange('10.0.0.0', 8)) return false;
    if (inRange('100.64.0.0', 10)) return false;
    if (inRange('127.0.0.0', 8)) return false;
    if (inRange('169.254.0.0', 16)) return false;
    if (inRange('172.16.0.0', 12)) return false;
    if (inRange('192.0.0.0', 24)) return false;
    if (inRange('192.0.2.0', 24)) return false;
    if (inRange('192.88.99.0', 24)) return false;
    if (inRange('192.168.0.0', 16)) return false;
    if (inRange('198.18.0.0', 15)) return false;
    if (inRange('198.51.100.0', 24)) return false;
    if (inRange('203.0.113.0', 24)) return false;
    if (inRange('224.0.0.0', 4)) return false;
    if (inRange('240.0.0.0', 4)) return false;
    return true;
  }
  const mapped = unwrapMappedV6(ip.toLowerCase());
  if (mapped) return isPublicAddress(mapped);
  const lower = ip.toLowerCase();
  if (lower === '::' || lower === '::1') return false;
  if (lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd')) return false;
  if (lower.startsWith('::ffff:')) return false; // non-mapped v4-in-v6 is handled above; be strict
  return true;
}

/** Resolve + validate a hostname once, returning a pinned public address.
 *  Every returned address must be public; the first is pinned for the
 *  connection. */
function resolvePinnedAddress(hostname: string): Promise<string> {
  return new Promise((resolve, reject) => {
    dns.lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error) return reject(new EhentaiUpstreamError('Could not resolve the E-Hentai image host.', 'unavailable'));
      if (!addresses.length) return reject(new EhentaiUpstreamError('The E-Hentai image host has no addresses.', 'unavailable'));
      const invalid = addresses.find((a) => !isPublicAddress(a.address));
      if (invalid) return reject(new EhentaiUpstreamError('Blocked: E-Hentai image host resolved to a private or reserved address.', 'blocked'));
      resolve(addresses[0].address);
    });
  });
}

// ---------------- pinned HTTPS request ----------------

interface PinnedRequestOptions {
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs: number;
  maxBytes: number;
  /** H@H images can use a port explicitly exposed by the viewer page.
   * The complete target origin must still pass validation on every hop. */
  allowNonStandardPort?: boolean;
  /** When set, the body streams straight to this file (.part + rename). */
  destPath?: string;
  onAttemptStart?: () => void;
  onBytes?: (receivedBytes: number, totalBytes: number | null) => void;
  /** Optional validator invoked on the `.part` file before atomic rename to `destPath`. */
  validatePart?: (partPath: string, contentType: string | null) => Promise<void>;
}

interface PinnedResponse {
  status: number;
  finalUrl: string;
  contentType: string | null;
  /** Present when destPath is not set (capped in-memory body). */
  body?: Buffer;
  bytesWritten?: number;
}

/** Manual-redirect HTTPS GET over a pinned, DNS-validated address. Host
 *  policy checks happen per hop via `validateHost`. */
function pinnedGet(
  startUrl: string,
  validateHost: (hostname: string, target: URL) => boolean,
  options: PinnedRequestOptions,
): Promise<PinnedResponse> {
  const doRequest = (url: string, redirectCount: number): Promise<PinnedResponse> => {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') {
      return Promise.reject(new EhentaiUpstreamError('Blocked: non-HTTPS redirect target.', 'blocked'));
    }
    if (parsed.port && parsed.port !== '443' && !options.allowNonStandardPort) {
      return Promise.reject(new EhentaiUpstreamError('Blocked: redirect target uses a non-standard port.', 'blocked'));
    }
    if (parsed.username || parsed.password) {
      return Promise.reject(new EhentaiUpstreamError('Blocked: redirect target carries userinfo.', 'blocked'));
    }
    if (!validateHost(parsed.hostname, parsed)) {
      return Promise.reject(new EhentaiUpstreamError('Blocked: redirect target is not an authorized E-Hentai host.', 'blocked'));
    }
    return resolvePinnedAddress(parsed.hostname).then((pinnedIp) => new Promise<PinnedResponse>((resolve, reject) => {
      let settled = false;
      let timeout: ReturnType<typeof setTimeout>;
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        try {
          req.destroy();
        } catch { /* already destroyed */ }
        cleanup();
        if (options.destPath) void fs.rm(`${options.destPath}.part`, { force: true }).catch(() => undefined);
        reject(error);
      };
      const onAbort = (): void => {
        fail(new RequestAbortedError());
      };
      const armTimeout = (): void => {
        clearTimeout(timeout);
        timeout = setTimeout(() => {
          try {
            req.destroy(new EhentaiUpstreamError('E-Hentai request timed out.', 'timeout'));
          } catch { /* already destroyed */ }
        }, options.timeoutMs);
      };
      timeout = setTimeout(() => {
        try {
          req.destroy(new EhentaiUpstreamError('E-Hentai request timed out.', 'timeout'));
        } catch { /* already destroyed */ }
      }, options.timeoutMs);
      const cleanup = (): void => {
        options.signal?.removeEventListener('abort', onAbort);
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });
      options.signal?.throwIfAborted();

      const req = https.request(
        {
          host: pinnedIp,
          servername: parsed.hostname,
          port: Number(parsed.port || 443),
          method: 'GET',
          path: `${parsed.pathname}${parsed.search}`,
          headers: { ...options.headers, Host: parsed.host },
        },
        (res) => {
          const status = res.statusCode ?? 0;
          const location = res.headers.location;
          // Drain and discard any body we do not consume.
          if (status >= 300 && status < 400 && location) {
            res.resume();
            if (redirectCount >= MAX_REDIRECTS) {
              fail(new EhentaiUpstreamError('Too many redirects from the E-Hentai host.', 'blocked'));
              return;
            }
            const next = new URL(location, url).toString();
            void doRequest(next, redirectCount + 1).then(resolve, (error) => fail(error as Error));
            return;
          }
          const contentType = res.headers['content-type'] ?? null;
          if (status < 200 || status >= 300) {
            res.resume();
            const retryAfter = parseRetryAfterMs(res.headers, 60_000);
            fail(new EhentaiUpstreamError(`E-Hentai returned HTTP ${status}.`, status >= 500 && status <= 509 ? (status === 509 ? 'quota' : 'unavailable') : status === 429 ? 'rate-limited' : status === 401 || status === 403 ? 'denied' : 'unavailable', status, retryAfter));
            return;
          }
          if (options.destPath) {
            const destPath = options.destPath;
            const partPath = `${destPath}.part`;
            armTimeout(); // headers received — start the idle window for the body
            options.onAttemptStart?.();
            void (async () => {
              let fh: fs.FileHandle | null = null;
              let published = false;
              let writeError: Error | null = null;
              let written = 0;
              try {
                fh = await fs.open(partPath, 'w');
                let received = 0;
                const totalHeader = res.headers['content-length'];
                const parsedTotal = totalHeader ? Number(totalHeader) : NaN;
                const totalBytes = Number.isFinite(parsedTotal) && parsedTotal > 0 ? parsedTotal : null;
                const hasEncoding = Boolean(res.headers['content-encoding']);
                for await (const chunk of res) {
                  if (settled || options.signal?.aborted) throw new RequestAbortedError();
                  armTimeout(); // bytes arrived — reset idle timeout for slow large images
                  const buf = chunk as Buffer;
                  received += buf.byteLength;
                  if (received > options.maxBytes) {
                    throw new EhentaiUpstreamError('E-Hentai response exceeded the size limit.', 'unavailable');
                  }
                  await fh.write(buf);
                  options.onBytes?.(received, totalBytes);
                }
                await fh.close();
                fh = null;
                if (settled || options.signal?.aborted) throw new RequestAbortedError();
                if (received === 0) {
                  throw new EhentaiUpstreamError('E-Hentai returned an empty image body.', 'unavailable');
                }
                if (totalBytes !== null && !hasEncoding && received < totalBytes) {
                  throw new EhentaiUpstreamError(`Incomplete download: received ${received} of ${totalBytes} bytes from E-Hentai.`, 'unavailable');
                }
                if (options.validatePart) {
                  await options.validatePart(partPath, contentType);
                }
                await fs.rename(partPath, destPath);
                published = true;
                written = received;
              } catch (error) {
                writeError = error instanceof Error ? error : new EhentaiUpstreamError('E-Hentai image write failed.', 'unavailable');
              } finally {
                if (fh) await fh.close().catch(() => undefined);
                if (!published) await fs.rm(partPath, { force: true }).catch(() => undefined);
              }
              if (writeError) {
                fail(writeError);
              } else if (!settled) {
                settled = true;
                clearTimeout(timeout);
                cleanup();
                resolve({ status, finalUrl: url, contentType, bytesWritten: written });
              }
            })();
            return;
          }
          const chunks: Buffer[] = [];
          let received = 0;
          res.on('data', (chunk: Buffer) => {
            received += chunk.byteLength;
            if (received > options.maxBytes) {
              res.destroy();
              fail(new EhentaiUpstreamError('E-Hentai response exceeded the size limit.', 'unavailable'));
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            cleanup();
            resolve({ status, finalUrl: url, contentType, body: Buffer.concat(chunks) });
          });
          res.on('error', () => fail(new EhentaiUpstreamError('E-Hentai connection error.', 'unavailable')));
        },
      );
      req.on('error', (error: Error) => {
        if (options.signal?.aborted) {
          fail(new RequestAbortedError());
          return;
        }
        // Timeouts arrive as the EhentaiUpstreamError passed to destroy().
        fail(error instanceof EhentaiUpstreamError ? error : new EhentaiUpstreamError('E-Hentai connection failed.', 'unavailable'));
      });
      req.end();
    }));
  };
  return doRequest(startUrl, 0);
}

// ---------------- lane-scoped fetch with gate + cookies ----------------

export interface EhentaiTextResponse {
  status: number;
  finalUrl: string;
  contentType: string | null;
  body: string;
}

export interface EhentaiFetchOptions {
  /** Which family host is authorized (cookies go only here). */
  site: EhentaiSite;
  /** The session to use. null = anonymous/public. */
  session?: EhentaiSessionInput | null;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Extra per-hop headers (e.g. Referer) — never use this to send cookies. */
  headers?: Record<string, string>;
}

/** Fetch a family-host HTML/JSON page through the pacing gate. The target
 *  must be on the authorized family host (or the metadata API for `lane:
 *  'api'`). Cookies are rebuilt for the final target host only. */
export async function ehentaiFetchText(
  url: string,
  lane: 'html' | 'api',
  options: EhentaiFetchOptions,
): Promise<EhentaiTextResponse> {
  const gate = getEhentaiGate();
  const release = await gate[lane].acquire(options.signal);
  try {
    const parsed = new URL(url);
    const authorizedHost = lane === 'api' ? API_HOST : ehentaiHost(options.site);
    if (parsed.hostname.toLowerCase() !== authorizedHost) {
      throw new EhentaiUpstreamError('Blocked: target host is not an authorized E-Hentai endpoint.', 'blocked');
    }
    const cookieHeader = lane === 'api' ? null : buildEhentaiCookies(options.session, options.site);
    const headers: Record<string, string> = {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.8',
      ...options.headers,
    };
    if (cookieHeader) headers.Cookie = cookieHeader;
    // Per-hop re-validation: the html lane may only stay on the family host;
    // the api lane has no redirects at all.
    const res = await pinnedGet(
      url,
      (hostname) => lane === 'api' ? hostname.toLowerCase() === API_HOST : hostname.toLowerCase() === authorizedHost,
      {
        headers,
        signal: options.signal,
        timeoutMs: options.timeoutMs ?? 30_000,
        maxBytes: lane === 'api' ? API_BODY_CAP : HTML_BODY_CAP,
      },
    );
    const body = res.body?.toString('utf8') ?? '';
    return { status: res.status, finalUrl: res.finalUrl, contentType: res.contentType, body };
  } catch (error) {
    if (error instanceof EhentaiUpstreamError && error.kind === 'rate-limited') {
      const cooldownMs = error.retryAfterMs ?? gate[lane].minGapMs * 5;
      if (cooldownMs > 0) gate[lane].setCooldown(Date.now() + cooldownMs);
    }
    throw error;
  } finally {
    release();
  }
}

/** POST JSON to the E-Hentai metadata API (no session cookies). */
export async function ehentaiApiPost(
  payload: { method: 'gdata'; gidlist: Array<[number, string]>; namespace: 1 },
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<EhentaiTextResponse> {
  const gate = getEhentaiGate();
  const release = await gate.api.acquire(options.signal);
  try {
    const url = `https://${API_HOST}/api.php`;
    const res = await pinnedGetPost(url, JSON.stringify(payload), {
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? 30_000,
      maxBytes: API_BODY_CAP,
    });
    return { status: res.status, finalUrl: res.finalUrl, contentType: res.contentType, body: res.body?.toString('utf8') ?? '' };
  } catch (error) {
    if (error instanceof EhentaiUpstreamError && error.kind === 'rate-limited') {
      const cooldownMs = error.retryAfterMs ?? gate.api.minGapMs * 5;
      if (cooldownMs > 0) gate.api.setCooldown(Date.now() + cooldownMs);
    }
    throw error;
  } finally {
    release();
  }
}

/** Native tag completion stays on the selected family host, with scoped cookies. */
export async function ehentaiTagSuggestions(text: string, options: EhentaiFetchOptions): Promise<EhentaiTextResponse> {
  const gate = getEhentaiGate();
  const release = await gate.api.acquire(options.signal);
  try {
    const cookie = buildEhentaiCookies(options.session, options.site);
    const res = await pinnedGetPost(`https://${ehentaiHost(options.site)}/api.php`, JSON.stringify({ method: 'tagsuggest', text }), {
      headers: { ...(cookie ? { Cookie: cookie } : {}), Referer: `https://${ehentaiHost(options.site)}/` },
      signal: options.signal, timeoutMs: options.timeoutMs ?? 15_000, maxBytes: API_BODY_CAP,
    });
    return { status: res.status, finalUrl: res.finalUrl, contentType: res.contentType, body: res.body?.toString('utf8') ?? '' };
  } catch (error) {
    if (error instanceof EhentaiUpstreamError && error.kind === 'rate-limited') {
      const cooldownMs = error.retryAfterMs ?? gate.api.minGapMs * 5;
      if (cooldownMs > 0) gate.api.setCooldown(Date.now() + cooldownMs);
    }
    throw error;
  } finally { release(); }
}

/** POST variant of the pinned request (JSON, no redirects expected). */
function pinnedGetPost(url: string, jsonBody: string, options: PinnedRequestOptions): Promise<PinnedResponse> {
  const parsed = new URL(url);
  return resolvePinnedAddress(parsed.hostname).then((pinnedIp) => new Promise<PinnedResponse>((resolve, reject) => {
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', onAbort);
      try {
        req.destroy();
      } catch { /* already destroyed */ }
      reject(error);
    };
    const onAbort = (): void => fail(new RequestAbortedError());
    const timeout = setTimeout(() => {
      try {
        req.destroy(new EhentaiUpstreamError('E-Hentai API request timed out.', 'timeout'));
      } catch { /* already destroyed */ }
    }, options.timeoutMs);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    options.signal?.throwIfAborted();
    const req = https.request(
      {
        host: pinnedIp,
        servername: parsed.hostname,
        port: 443,
        method: 'POST',
        path: parsed.pathname,
        headers: {
          ...options.headers,
          Host: parsed.hostname,
          'User-Agent': UA,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(jsonBody),
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const chunks: Buffer[] = [];
        let received = 0;
        res.on('data', (chunk: Buffer) => {
          received += chunk.byteLength;
          if (received > options.maxBytes) {
            res.destroy();
            fail(new EhentaiUpstreamError('E-Hentai API response exceeded the size limit.', 'unavailable'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          if (settled) return;
          if (status < 200 || status >= 300) {
            const retryAfterMs = status === 429 ? parseRetryAfterMs(res.headers, 60_000) : null;
            fail(new EhentaiUpstreamError(`E-Hentai API returned HTTP ${status}.`, status === 429 ? 'rate-limited' : 'unavailable', status, retryAfterMs));
            return;
          }
          settled = true;
          clearTimeout(timeout);
          options.signal?.removeEventListener('abort', onAbort);
          resolve({ status, finalUrl: url, contentType: res.headers['content-type'] ?? null, body: Buffer.concat(chunks) });
        });
        res.on('error', () => fail(new EhentaiUpstreamError('E-Hentai API connection error.', 'unavailable')));
      },
    );
    req.on('error', () => {
      if (options.signal?.aborted) {
        fail(new RequestAbortedError());
        return;
      }
      fail(new EhentaiUpstreamError('E-Hentai API connection failed.', 'unavailable'));
    });
    req.end(jsonBody);
  }));
}

// ---------------- image approvals (per gallery, from authorized pages) ----------------

interface ImageApproval {
  origins: Set<string>;
  at: number;
  accountRevision: number;
}
const APPROVAL_TTL_MS = 10 * 60_000;
const approvals = new Map<string, ImageApproval>();

/** Register the image origins seen on an authorized viewer page for one
 *  gallery. Only these targets (plus static family image hosts) may be
 *  fetched for image bytes. */
export function approveGalleryImageRefs(galleryKey: string, refs: string[]): void {
  const approval: ImageApproval = { origins: new Set(), at: Date.now(), accountRevision: getAccountRevision() };
  for (const ref of refs) {
    try {
      const parsed = new URL(ref);
      if (parsed.protocol !== 'https:') continue;
      if (!parsed.username && !parsed.password) approval.origins.add(parsed.origin);
    } catch {
      /* unparseable refs are simply not approved */
    }
  }
  approvals.set(galleryKey, approval);
  while (approvals.size > 256) {
    const oldest = approvals.keys().next().value;
    if (oldest === undefined) break;
    approvals.delete(oldest);
  }
}

/** True when an image URL is approved for this gallery (an approved origin
 *  or a static host) and the approval matches the current account
 *  revision window. */
export function isApprovedImageUrl(galleryKey: string, url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    if (parsed.username || parsed.password) return false;
    const host = parsed.hostname.toLowerCase();
    if (!parsed.port && STATIC_IMAGE_HOSTS.has(host)) return true;
    const approval = approvals.get(galleryKey);
    if (!approval) return false;
    if (Date.now() - approval.at > APPROVAL_TTL_MS) return false;
    if (approval.accountRevision !== getAccountRevision()) return false;
    return approval.origins.has(parsed.origin);
  } catch {
    return false;
  }
}

// Account cutover invalidates every approval: old pages must not keep
// authorizing restricted image targets under a different/no session.
onEhentaiAccountChange(() => {
  approvals.clear();
});

// ---------------- image response validation ----------------

export type ImageFormat = 'jpg' | 'png' | 'gif' | 'webp';

/** Detect the real image format from magic bytes. */
export function detectImageFormat(head: Buffer): ImageFormat | null {
  if (head.length < 12) return null;
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpg';
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return 'png';
  if (head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x38) return 'gif';
  if (head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46 && head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50) return 'webp';
  return null;
}

const MIN_IMAGE_BYTES = 1024;

/**
 * Validate a downloaded image before its final name is published. Rejects
 * HTML/login pages, empty bodies, and sub-threshold placeholders even on
 * HTTP 200. Returns the detected format (drives the persisted page
 * extension).
 */
export function validateImageFile(filePath: string, contentType: string | null): Promise<ImageFormat> {
  return fs.open(filePath, 'r').then(async (fh) => {
    try {
      const stat = await fh.stat();
      if (stat.size < MIN_IMAGE_BYTES) {
        throw new EhentaiUpstreamError('Rejected: E-Hentai returned an empty or placeholder image.', 'denied');
      }
      const head = Buffer.alloc(16);
      const { bytesRead } = await fh.read(head, 0, 16, 0);
      const format = detectImageFormat(head.subarray(0, bytesRead));
      if (!format) {
        // Some content types carry real data without a sniffable head;
        // trust an explicit image/* content type only.
        const declared = (contentType ?? '').split(';')[0].trim().toLowerCase();
        if (declared.startsWith('image/')) {
          return declared.includes('jpeg') ? 'jpg' : declared.includes('png') ? 'png' : declared.includes('gif') ? 'gif' : 'webp';
        }
        throw new EhentaiUpstreamError('Rejected: E-Hentai response is not a supported image.', 'parse');
      }
      return format;
    } finally {
      await fh.close();
    }
  });
}

/** Stream one approved viewer image to a file through the image pacing gate.
 *  Validates magic bytes and size on `.part` BEFORE atomic rename to `destPath`,
 *  returning the detected image format and written byte count. */
export async function fetchEhentaiImage(
  url: string,
  options: {
    site: EhentaiSite;
    galleryKey: string;
    destPath: string;
    referer: string;
    signal?: AbortSignal;
    onAttemptStart?: () => void;
    onBytes?: (receivedBytes: number, totalBytes: number | null) => void;
  },
): Promise<{ format: ImageFormat; bytes: number }> {
  if (!isApprovedImageUrl(options.galleryKey, url)) {
    throw new EhentaiUpstreamError('Blocked: image target was not obtained from the authorized gallery page.', 'blocked');
  }
  const gate = getEhentaiGate();
  const release = await gate.image.acquire(options.signal);
  try {
    let detectedFormat: ImageFormat | null = null;
    // No cookies for image hosts; the Referer identifies the gallery page.
    const res = await pinnedGet(
      url,
      (_hostname, target) => isApprovedImageUrl(options.galleryKey, target.toString()),
      {
        headers: { 'User-Agent': UA, Referer: options.referer, Accept: 'image/avif,image/webp,image/*;q=0.8' },
        signal: options.signal,
        timeoutMs: 60_000,
        maxBytes: 64 * 1024 * 1024,
        allowNonStandardPort: true,
        destPath: options.destPath,
        onAttemptStart: options.onAttemptStart,
        onBytes: options.onBytes,
        validatePart: async (partPath, contentType) => {
          detectedFormat = await validateImageFile(partPath, contentType);
        },
      },
    );
    return {
      format: detectedFormat ?? await validateImageFile(options.destPath, res.contentType),
      bytes: res.bytesWritten ?? 0,
    };
  } catch (error) {
    if (error instanceof EhentaiUpstreamError && error.kind === 'rate-limited') {
      const cooldownMs = error.retryAfterMs ?? gate.image.minGapMs * 5;
      if (cooldownMs > 0) gate.image.setCooldown(Date.now() + cooldownMs);
    }
    throw error;
  } finally {
    release();
  }
}

// ---------------- access classification ----------------

/** Positive marker of a genuine member-only page (the favorites-management
 *  UI) — required to claim verified access. The public front page is
 *  identical for guests and members, so an HTTP 200 or a public gallery
 *  list must never count as verified; on member pages guests are
 *  redirected to /login.php instead. */
const FAVORITES_PAGE_MARKER = 'update_fav_action';
/** ExHentai denial markers (access refused despite a 200). */
const EXHENTAI_DENIED_MARKERS = ['not authorized', 'do not have access', 'no access to', 'exhentai is only available', 'you are not allowed'];
/** Age/content gate markers. */
const CONTENT_WARNING_MARKERS = ['content warning', 'adult content', 'not 18', 'age verification'];

export interface EhentaiAccessEvidence {
  state: 'verified' | 'denied' | 'content-warning' | 'unavailable' | 'quota-limited' | 'rate-limited' | 'untested';
  message?: string;
  /** Raw classification detail for server logs (sanitized). */
  detail?: string;
}

/** Classify a fetched family page as access evidence. A positive marker is
 *  required for 'verified'; HTTP success alone never verifies. */
export function classifyAccessEvidence(site: EhentaiSite, response: { status: number; finalUrl: string; body: string }): EhentaiAccessEvidence {
  const final = (() => {
    try {
      return new URL(response.finalUrl);
    } catch {
      return null;
    }
  })();
  const finalHost = final?.hostname.toLowerCase() ?? null;
  const bodyLower = response.body.toLowerCase();
  const memberPage = bodyLower.includes(FAVORITES_PAGE_MARKER);

  if (response.status === 429) {
    return { state: 'rate-limited', message: 'The E-Hentai host is rate-limiting requests. Try again in a few minutes.', detail: 'http-429' };
  }
  if (response.status === 509) {
    return { state: 'quota-limited', message: 'The E-Hentai image/gallery quota is exhausted for this account.', detail: 'http-509' };
  }
  if (response.status === 401 || response.status === 403) {
    return { state: 'denied', message: 'The site refused this session. Re-test or re-save the account in Settings.', detail: `http-${response.status}` };
  }
  if (response.status >= 500) {
    return { state: 'unavailable', message: 'The E-Hentai host is temporarily unavailable.', detail: `http-${response.status}` };
  }
  if ((finalHost !== null && finalHost !== ehentaiHost(site)) || final?.pathname === '/login.php') {
    // Guests hitting a member page land on the login form; a different host
    // means the session did not stick.
    return { state: 'denied', message: 'The session did not authenticate. Re-copy the cookies from a logged-in browser.', detail: `redirected-to-${final ? final.pathname : finalHost}` };
  }
  if (CONTENT_WARNING_MARKERS.some((m) => bodyLower.includes(m)) && !memberPage) {
    return { state: 'content-warning', message: 'The site returned a content/age gate. Confirm the gate in your browser with this account, then test again.', detail: 'content-warning' };
  }
  // A real member page means the site authenticated this session; nothing
  // weaker counts (the public front page is indistinguishable for guests).
  if (memberPage) {
    return { state: 'verified', detail: 'member-page' };
  }
  if (EXHENTAI_DENIED_MARKERS.some((m) => bodyLower.includes(m))) {
    return { state: 'denied', message: site === 'exhentai' ? 'The account is authenticated but does not have ExHentai access.' : 'Access was denied by the site.', detail: 'denial-marker' };
  }
  // ExHentai answers 200 with an empty body when the session lacks ExHentai
  // access (observed live against the site).
  if (site === 'exhentai' && response.body.length === 0) {
    return { state: 'denied', message: 'ExHentai did not serve a member page for this session. Accounts without ExHentai access are expected to see this; if your account has access, re-copy the cookies.', detail: 'empty-body' };
  }
  return { state: 'unavailable', message: 'The site returned an unexpected response. Try again later or verify the account manually in a browser.', detail: 'unexpected-body' };
}

export interface EhentaiAccessTestResult {
  eHentai: EhentaiAccessEvidence;
  exHentai: EhentaiAccessEvidence;
  testedAt: string;
}

/**
 * Verify a session against both family sites without downloading gallery
 * images: one member-page request per site (favorites.php — guests are
 * redirected to the login form there, so only an authenticated session
 * receives a member page; the public front page would look identical for
 * guests and members). Testing a draft does not save it. Results are
 * evidence with a timestamp, not permanent authorization.
 */
export async function testEhentaiAccess(session: EhentaiSessionInput, options: { signal?: AbortSignal } = {}): Promise<EhentaiAccessTestResult> {
  const testedAt = new Date().toISOString();
  const checkSite = async (site: EhentaiSite): Promise<EhentaiAccessEvidence> => {
    try {
      const response = await ehentaiFetchText(`https://${ehentaiHost(site)}/favorites.php`, 'html', { site, session, signal: options.signal });
      return classifyAccessEvidence(site, response);
    } catch (error) {
      if (error instanceof RequestAbortedError) throw error;
      if (error instanceof EhentaiUpstreamError) {
        const mapped: Record<EhentaiFailureKind, EhentaiAccessEvidence['state']> = {
          quota: 'quota-limited',
          denied: 'denied',
          unavailable: 'unavailable',
          'rate-limited': 'rate-limited',
          blocked: 'unavailable',
          parse: 'unavailable',
          timeout: 'unavailable',
        };
        return { state: mapped[error.kind], message: error.message, detail: `error:${error.kind}` };
      }
      return { state: 'unavailable', message: 'The E-Hentai host could not be reached.', detail: 'error:other' };
    }
  };
  // Sequential: the shared html lane already paces them, and a failed
  // session must not be hammered on both hosts in parallel.
  const eHentai = await checkSite('e-hentai');
  const exHentai = await checkSite('exhentai');
  return { eHentai, exHentai, testedAt };
}
