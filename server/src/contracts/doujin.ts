/**
 * Shared JSON-safe doujinshi contracts.
 *
 * Single definition of the registered gallery sources, the E-Hentai family
 * gallery identity, and the public search / unified-search DTOs. Pure module:
 * no settings, HTTP, DB, or provider imports — every value here is
 * serializable and deterministic so routes, queue rows, and the (mirrored)
 * web DTOs validate the same shapes. Server-only request machinery (cookies,
 * live page resolvers, provider closures) lives in the downloader
 * implementation, never here.
 */

// ---------------------------------------------------------------------------
// Registered sources
// ---------------------------------------------------------------------------

/** The three logical download providers. E-Hentai and ExHentai are two sites
 *  within the single `ehentai` provider — never a fourth source. */
export const DOUJIN_SOURCES = ['hitomi', 'nhentai', 'ehentai'] as const;

export type DoujinSource = (typeof DOUJIN_SOURCES)[number];

/** Runtime guard for untrusted input (client payloads, persisted rows). */
export function isDoujinSource(value: unknown): value is DoujinSource {
  return typeof value === 'string' && (DOUJIN_SOURCES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// E-Hentai family identity
// ---------------------------------------------------------------------------

/** The two access sites of the single `ehentai` logical provider. */
export const EHENTAI_SITES = ['e-hentai', 'exhentai'] as const;

export type EhentaiSite = (typeof EHENTAI_SITES)[number];

export function isEhentaiSite(value: unknown): value is EhentaiSite {
  return typeof value === 'string' && (EHENTAI_SITES as readonly string[]).includes(value);
}

const EHENTAI_HOSTS: Record<EhentaiSite, string> = {
  'e-hentai': 'e-hentai.org',
  exhentai: 'exhentai.org',
};

export function ehentaiHost(site: EhentaiSite): string {
  return EHENTAI_HOSTS[site];
}

/** Exact-host lookup only — www, mirrors, subdomains, and lookalikes fail. */
export function ehentaiSiteForHost(host: string): EhentaiSite | null {
  const normalized = host.toLowerCase();
  for (const site of EHENTAI_SITES) {
    if (normalized === EHENTAI_HOSTS[site]) return site;
  }
  return null;
}

const GID_RE = /^[1-9]\d{0,9}$/;
const TOKEN_RE = /^[0-9a-f]{12}$/;

/**
 * Canonical E-Hentai gallery identity. The `(gid, token)` pair is validated
 * once; the canonical ID is the shared queue/ownership key across both family
 * hosts. A bare gid without its token is never a resolvable identity.
 */
export interface EhentaiGalleryIdentity {
  gid: string;
  token: string;
  canonicalId: string;
}

/** Validate and canonicalize a bare `<gid>-<token>` gallery ID. */
export function parseEhentaiGalleryId(input: unknown): EhentaiGalleryIdentity | null {
  if (typeof input !== 'string' || input.length > 64) return null;
  const m = /^(\d+)-([0-9a-fA-F]{12})$/.exec(input.trim());
  if (!m) return null;
  const gid = m[1];
  const token = m[2].toLowerCase();
  if (!GID_RE.test(gid) || !TOKEN_RE.test(token)) return null;
  return { gid, token, canonicalId: `${gid}-${token}` };
}

/** A validated gallery URL on one family host, with its canonical form. */
export interface EhentaiGalleryUrl extends EhentaiGalleryIdentity {
  /** The actual host the locator points at. */
  site: EhentaiSite;
  /** Canonical `https://<host>/g/<gid>/<token>/` URL. */
  url: string;
}

/**
 * Parse a gallery locator from either family host. Only exact-host, HTTPS,
 * `/g/<gid>/<token>/` URLs are accepted. Rejected: other schemes, ports,
 * userinfo, mirrors/subdomains, query/fragment, non-gallery paths, and
 * malformed gid/token. A bare numeric ID is not a locator.
 */
export function parseEhentaiGalleryUrl(raw: unknown): EhentaiGalleryUrl | null {
  if (typeof raw !== 'string' || raw.length > 1024) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  const site = ehentaiSiteForHost(url.hostname);
  if (!site) return null;
  if (url.port !== '' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') return null;
  const m = /^\/g\/(\d+)\/([0-9a-fA-F]{12})\/?$/.exec(url.pathname);
  if (!m) return null;
  const gid = m[1];
  const token = m[2].toLowerCase();
  if (!GID_RE.test(gid) || !TOKEN_RE.test(token)) return null;
  return { gid, token, canonicalId: `${gid}-${token}`, site, url: ehentaiGalleryUrl(site, gid, token) };
}

export function ehentaiGalleryUrl(site: EhentaiSite, gid: string, token: string): string {
  return `https://${EHENTAI_HOSTS[site]}/g/${gid}/${token.toLowerCase()}/`;
}

/** True when two E-Hentai locators (any host) name the same gallery revision. */
export function ehentaiSameIdentity(a: { canonicalId: string }, b: { canonicalId: string }): boolean {
  return a.canonicalId === b.canonicalId;
}

// ---------------------------------------------------------------------------
// Public result DTO
// ---------------------------------------------------------------------------

/**
 * Public (JSON) shape of one gallery search result — the fixed contract every
 * provider result is serialized into before crossing the API boundary.
 * Server-internal fields (page lists, live resolvers, request headers) never
 * appear here.
 */
export interface PublicDoujinSearchResult {
  source: DoujinSource;
  galleryId: string;
  title: string;
  coverUrl: string | null;
  language: string | null;
  tags: string[];
  artists: string[];
  pageCount: number | null;
  /** Canonical gallery URL (user-facing). */
  url: string | null;
  /** Upload/publish date, ISO 8601. */
  uploadedAt: string | null;
  /** E-Hentai family only: the actual site this result was found on. */
  site?: EhentaiSite;
}

/**
 * Coerce a provider result (a superset of the public fields) into the public
 * DTO. Returns null when the row does not name a registered source —
 * callers must not serialize unknown sources.
 */
export function toPublicSearchResult(r: {
  source: string;
  galleryId: string;
  title: string;
  coverUrl?: string | null;
  language?: string | null;
  tags?: string[];
  artists?: string[];
  pageCount?: number | null;
  url?: string | null;
  uploadedAt?: string | null;
  site?: string | null;
}): PublicDoujinSearchResult | null {
  if (!isDoujinSource(r.source) || typeof r.galleryId !== 'string' || !r.galleryId.trim() || typeof r.title !== 'string') return null;
  const out: PublicDoujinSearchResult = {
    source: r.source,
    galleryId: r.galleryId,
    title: r.title,
    coverUrl: typeof r.coverUrl === 'string' && r.coverUrl ? r.coverUrl : null,
    language: typeof r.language === 'string' && r.language ? r.language : null,
    tags: Array.isArray(r.tags) ? r.tags.filter((t) => typeof t === 'string') : [],
    artists: Array.isArray(r.artists) ? r.artists.filter((a) => typeof a === 'string') : [],
    pageCount: typeof r.pageCount === 'number' && Number.isFinite(r.pageCount) && r.pageCount >= 0 ? r.pageCount : null,
    url: typeof r.url === 'string' && r.url ? r.url : null,
    uploadedAt: typeof r.uploadedAt === 'string' && r.uploadedAt ? r.uploadedAt : null,
  };
  if (r.source === 'ehentai' && isEhentaiSite(r.site)) out.site = r.site;
  return out;
}

// ---------------------------------------------------------------------------
// Bounded provider search seam (cursor chunks)
// ---------------------------------------------------------------------------

/** Opaque server-issued continuation cursor. Clients must never parse, log,
 *  or mutate it; it is bound server-side to query, options, site, and account
 *  revisions. */
export type SearchCursor = string;

/** One bounded chunk of provider results plus its continuation. */
export interface SearchChunk<T> {
  items: T[];
  nextCursor: SearchCursor | null;
  exhausted: boolean;
  /** The provider's exact total for the query, when it exposes one. */
  total?: number;
}

// ---------------------------------------------------------------------------
// Unified search DTOs
// ---------------------------------------------------------------------------

/** A parsed provider-agnostic search query (compiled per-provider by the
 *  aggregation service; the raw input is preserved for display/drafts). */
export interface CommonSearchQuery {
  /** Raw user input, verbatim. */
  raw: string;
  /** Plain keyword terms (ANDed across providers). */
  keywords: string[];
  /** Quoted phrases. */
  phrases: string[];
  /** Supported shared filters. */
  filters: Array<{ namespace: 'artist' | 'group' | 'parody' | 'character' | 'language'; value: string }>;
  /** Negated terms: `-term` for keywords, `{namespace, value}` for filters. */
  exclusions: Array<{ namespace: string | null; value: string }>;
}

/** One real provider gallery inside a unified search entry. */
export interface GalleryVariant {
  source: DoujinSource;
  galleryId: string;
  /** E-Hentai family only: the site this variant was found on. */
  site?: EhentaiSite;
  title: string;
  coverUrl: string | null;
  url: string | null;
  artists: string[];
  language: string | null;
  pageCount: number | null;
  uploadedAt: string | null;
  /** 1-based rank within this provider's native result ordering. */
  providerPosition: number;
}

export type ProviderLaneStatus =
  | 'success' // results delivered; more may follow
  | 'exhausted' // provider returned all of its results
  | 'failed' // provider error (sanitized message)
  | 'unavailable' // provider temporarily unreachable
  | 'not-configured' // e.g. ExHentai selected but no valid session
  | 'rate-limited' // provider pacing/quota exhausted for this search
  | 'unsupported-query' // a shared filter cannot be represented without widening
  | 'not-applicable'; // the input (e.g. another provider's gallery URL) does not apply

export interface ProviderSearchStatus {
  source: DoujinSource;
  status: ProviderLaneStatus;
  /** Sanitized user-facing guidance. Never cookies, upstream bodies, or URLs
   *  carrying credentials. */
  message?: string;
  retryable: boolean;
}

/** One visible card: a stable group of strongly matched gallery variants.
 *  `entryId` is a display-group identity, never a queue gallery ID. */
export interface UnifiedSearchEntry {
  entryId: string;
  /** The variant the card renders by default — the first variant seen. */
  primary: PublicDoujinSearchResult;
  /** All known variants, including `primary`, in discovery order. */
  variants: GalleryVariant[];
}

/** One unified search response: new cards, in-place variant updates, and the
 *  continuation. `items` never repeats a delivered entry; a later duplicate
 *  arrives in `updates` for the existing `entryId`. */
export interface UnifiedSearchPage {
  items: UnifiedSearchEntry[];
  updates: UnifiedSearchEntry[];
  nextCursor: SearchCursor | null;
  hasMore: boolean;
  /** Unique galleries loaded across the whole session so far. */
  loadedUniqueCount: number;
  providers: ProviderSearchStatus[];
  /** Exact unique total — present only when every applicable lane is
   *  exhausted and deduplication covered their returned results. */
  totalUnique?: number;
}
