/**
 * Unified search across Hitomi.la, nHentai, and the E-Hentai/ExHentai family.
 *
 * One query is parsed into a provider-agnostic form once, compiled to each
 * provider's real syntax, and fetched through bounded lanes that run
 * concurrently with explicit per-lane failure states (plan P2.2). Results are
 * interleaved in deterministic source order, grouped conservatively by exact
 * identity and strict metadata fingerprints, and paged through a small
 * in-memory session store with opaque cursors (plan P2.4).
 *
 * Cursor semantics: a cursor names the search state after the page that issued
 * it. The first request with a cursor produces the next page and pins that
 * page to the cursor; repeating the same cursor replays the same response.
 * Any cursor that is neither the pending one nor the last served one is stale.
 *
 * Honesty constraints: provider relevance/recall legitimately differ; "N
 * unique galleries loaded" is never a summed provider total; uncertain
 * editions stay separate rather than being merged.
 */

import { randomBytes } from 'node:crypto';
import { doujinProviders, getDoujinProvider } from '../downloader/providers.js';
import type { DoujinSearchResult } from '../downloader/types.js';
import { EhentaiUpstreamError } from '../downloader/ehentaiClient.js';
import { EHENTAI_LANGUAGE_IDS } from '../downloader/ehentai.js';
import { parseEhentaiGalleryUrl } from '../contracts/doujin.js';
import {
  toPublicSearchResult,
  type CommonSearchQuery,
  type DoujinSource,
  type GalleryVariant,
  type PublicDoujinSearchResult,
  type ProviderLaneStatus,
  type ProviderSearchStatus,
  type SearchChunk,
  type SearchCursor,
  type UnifiedSearchEntry,
  type UnifiedSearchPage,
} from '../contracts/doujin.js';
import { getAccountRevision, getEhentaiAccountSite, isAccountConfigured, onEhentaiAccountChange } from './ehentaiAccount.js';
import { getDownloaderSettings, onSettingChange } from './settings.js';
import { rewriteDoujinCover } from '../routes/media.js';
import { compileEhentai, compileHitomi, compileNhentai, parseCommonQuery, type CompiledLaneQuery } from './unifiedQuery.js';

// ---------------- limits ----------------

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 50;
const LANE_DEADLINE_MS = 20_000;
/** Extra provider chunks per request beyond the first — bounds upstream work. */
const MAX_EXTRA_CHUNKS_PER_REQUEST = 2;
const SESSION_IDLE_TTL_MS = 15 * 60_000;
const MAX_SESSIONS = 50;
const MAX_ENTRIES_PER_SESSION = 2000;
const LANE_RETRY_LIMIT = 1;

const SOURCE_ORDER = Object.keys(doujinProviders) as DoujinSource[];

// ---------------- typed errors ----------------

export class UnifiedQueryError extends Error {}
export class UnifiedSessionError extends Error {
  constructor(message: string, public readonly kind: 'expired' | 'invalidated' | 'stale') {
    super(message);
    this.name = 'UnifiedSessionError';
  }
}

// ---------------- raw query classification (P2.1: URLs/IDs are not keywords) ----------------

type RawClassification =
  | { kind: 'normal' }
  | { kind: 'url'; source: DoujinSource; url: string }
  | { kind: 'ambiguous-id' };

function classifyRawQuery(raw: string): RawClassification {
  const input = raw.trim();
  const eh = parseEhentaiGalleryUrl(input);
  if (eh) return { kind: 'url', source: 'ehentai', url: eh.url };
  if (/^https?:\/\/(www\.)?hitomi\.la\/(?:g|doujinshi|manga|cg)\/\d+\/?$/i.test(input)) {
    return { kind: 'url', source: 'hitomi', url: input };
  }
  if (/^https?:\/\/(www\.)?nhentai\.net\/g\/\d+\/(?:[^/]+\/?)?$/i.test(input)) {
    return { kind: 'url', source: 'nhentai', url: input };
  }
  // A bare numeric id is ambiguous: every source uses numeric ids.
  if (/^\d{1,7}$/.test(input)) return { kind: 'ambiguous-id' };
  return { kind: 'normal' };
}

// ---------------- lanes ----------------

type LanePhase =
  | 'idle'
  | 'success'
  | 'exhausted'
  | 'failed'
  | 'unavailable'
  | 'not-configured'
  | 'rate-limited'
  | 'unsupported-query'
  | 'not-applicable';

interface Candidate {
  pub: PublicDoujinSearchResult;
  /** 1-based rank within the provider's native result ordering. */
  rank: number;
}

interface LaneState {
  source: DoujinSource;
  phase: LanePhase;
  message?: string;
  retryable: boolean;
  /** hitomi/nhentai: numeric offset; ehentai: opaque provider cursor. */
  continuation: { offset?: number; cursor?: SearchCursor };
  buffer: Candidate[];
  rank: number;
  retriesUsed: number;
}

interface SessionContext {
  query: string;
  principal: string | null;
  ehentaiSite: string;
  accountRevision: number;
  /** Fingerprint of the downloader settings that affect results (bans). */
  settingsFingerprint: string;
}

interface UnifiedSession {
  context: SessionContext;
  compiled: Record<DoujinSource, CompiledLaneQuery>;
  lanes: LaneState[];
  /** identity key -> entryId */
  identityToEntry: Map<string, string>;
  /** fingerprint -> entryId */
  fingerprintToEntry: Map<string, string>;
  entries: Map<string, UnifiedSearchEntry>;
  delivered: Set<string>;
  pendingUpdates: Set<string>;
  seq: number;
  /** Cursor whose response has not been produced yet (null when none). */
  nextCursor: SearchCursor | null;
  /** Cursor whose response was produced and is replayable (null on first page). */
  servedCursor: SearchCursor | null;
  lastResponse: UnifiedSearchPage | null;
  inflight: Promise<UnifiedSearchPage> | null;
  /** null = alive; otherwise the invalidation reason. */
  dead: string | null;
  /** Every store key pointing at this session. */
  keys: Set<SearchCursor>;
  createdAt: number;
  lastUsedAt: number;
}

const sessions = new Map<SearchCursor, UnifiedSession>();

function issueCursor(): SearchCursor {
  return randomBytes(24).toString('base64url');
}

function evictExpired(): void {
  const t = Date.now();
  // Dead sessions are kept (with their invalidation reason) until the idle
  // lifetime so a replayed cursor receives the specific error, not a generic
  // "expired".
  for (const session of sessions.values()) {
    if (t - session.lastUsedAt <= SESSION_IDLE_TTL_MS) continue;
    for (const key of session.keys) sessions.delete(key);
    session.keys.clear();
  }
  if (sessions.size < MAX_SESSIONS * 2) return;
  // Cap: drop the oldest still-alive session (its keys leave with it).
  let oldest: UnifiedSession | null = null;
  const seen = new Set<UnifiedSession>();
  for (const session of sessions.values()) {
    if (session.dead || seen.has(session)) continue;
    seen.add(session);
    if (!oldest || session.lastUsedAt < oldest.lastUsedAt) oldest = session;
  }
  if (oldest) {
    for (const key of oldest.keys) sessions.delete(key);
    oldest.keys.clear();
  }
}

// Account/site/exclusion cutover invalidates sessions immediately: old cursors
// must not keep serving results from the previous account/settings.
onEhentaiAccountChange(() => {
  for (const session of sessions.values()) session.dead = 'The E-Hentai account changed; start the search again.';
});
onSettingChange('downloader', () => {
  for (const session of sessions.values()) session.dead = 'Downloader settings changed; start the search again.';
});

function settingsFingerprint(): string {
  const s = getDownloaderSettings();
  return JSON.stringify([s.nhentaiBannedTags, s.hitomiBannedTags, s.ehentaiBannedTags]);
}

// ---------------- identity & fingerprinting (P2.3) ----------------

function identityKey(source: DoujinSource, galleryId: string): string {
  // E-Hentai galleryId is already the canonical family `<gid>-<token>` shared
  // by both family hosts, so both representations coalesce here.
  return `${source}:${galleryId}`;
}

/** Strict normalization: NFKC, lowercase, letters (incl. CJK/Cyrillic)/digits only. */
function normalizeText(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[^0-9a-z\u0400-\u04ff\u3040-\u30ff\uac00-\ud7af\u3130-\u318f\u4e00-\u9fff\uf900-\ufaff]+/g, '');
}

const LANGUAGE_CODES_TO_NAMES: Record<string, string> = {
  en: 'english', ja: 'japanese', ko: 'korean', zh: 'chinese', es: 'spanish', fr: 'french',
  de: 'german', it: 'italian', pt: 'portuguese', ru: 'russian', tr: 'turkish', id: 'indonesian',
  vi: 'vietnamese', th: 'thai', pl: 'polish', nl: 'dutch', he: 'hebrew', hu: 'hungarian',
  cs: 'czech', sv: 'swedish', el: 'greek', uk: 'ukrainian', da: 'danish', no: 'norwegian',
  fi: 'finnish', et: 'estonian', sk: 'slovak', sl: 'slovenian', lt: 'lithuanian', lv: 'latvian',
  sr: 'serbian', ro: 'romanian', hr: 'croatian', bg: 'bulgarian', ar: 'arabic', fa: 'persian',
  hi: 'hindi', af: 'afrikaans', ca: 'catalan', mn: 'mongolian',
};

function normalizeLanguage(value: string | null | undefined): string | null {
  if (!value) return null;
  const v = value.trim().toLowerCase().replace(/\s+/g, ' ');
  if (LANGUAGE_CODES_TO_NAMES[v]) return LANGUAGE_CODES_TO_NAMES[v];
  return v.replace(/s$/, '') === 'ukranian' ? 'ukrainian' : v || null;
}

/**
 * A strict cross-provider group key. Missing pieces are NOT wildcards: any
 * missing/unknown title, artist, language, or page count keeps the candidate
 * in its own entry (P2.3.6).
 */
function fingerprint(pub: PublicDoujinSearchResult): string | null {
  const title = normalizeText(pub.title);
  const artists = pub.artists.map(normalizeText).filter(Boolean);
  if (!title || artists.length === 0) return null;
  const language = normalizeLanguage(pub.language);
  if (!language) return null;
  if (pub.pageCount === null || pub.pageCount <= 0) return null;
  return `t=${title}|a=${artists[0]}|l=${language}|p=${pub.pageCount}`;
}

// ---------------- session lifecycle ----------------

function makeLane(source: DoujinSource): LaneState {
  return { source, phase: 'idle', retryable: false, continuation: {}, buffer: [], rank: 0, retriesUsed: 0 };
}

function newSession(query: string, principal: string | null, compiled: Record<DoujinSource, CompiledLaneQuery>): UnifiedSession {
  const session: UnifiedSession = {
    context: {
      query,
      principal,
      ehentaiSite: getEhentaiAccountSite(),
      accountRevision: getAccountRevision(),
      settingsFingerprint: settingsFingerprint(),
    },
    compiled,
    lanes: SOURCE_ORDER.map(makeLane),
    identityToEntry: new Map(),
    fingerprintToEntry: new Map(),
    entries: new Map(),
    delivered: new Set(),
    pendingUpdates: new Set(),
    seq: 0,
    nextCursor: null,
    servedCursor: null,
    lastResponse: null,
    inflight: null,
    dead: null,
    keys: new Set(),
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
  };
  return session;
}

/** Verify the session still matches the live account/settings/principal. */
function assertSessionLive(session: UnifiedSession, principal: string | null): void {
  if (session.dead) throw new UnifiedSessionError(session.dead, 'invalidated');
  if (session.context.principal !== principal) {
    throw new UnifiedSessionError('This search belongs to another session. Start again.', 'invalidated');
  }
  if (session.context.ehentaiSite !== getEhentaiAccountSite()) {
    throw new UnifiedSessionError('The E-Hentai account site changed; start the search again.', 'invalidated');
  }
  if (session.context.accountRevision !== getAccountRevision()) {
    throw new UnifiedSessionError('The E-Hentai account changed; start the search again.', 'invalidated');
  }
  if (session.context.settingsFingerprint !== settingsFingerprint()) {
    throw new UnifiedSessionError('Downloader settings changed; start the search again.', 'invalidated');
  }
}

function registerKey(session: UnifiedSession, cursor: SearchCursor): void {
  session.keys.add(cursor);
  sessions.set(cursor, session);
}

// ---------------- lane fetching ----------------

function compileLanes(query: CommonSearchQuery): Record<DoujinSource, CompiledLaneQuery> {
  return {
    hitomi: compileHitomi(query),
    nhentai: compileNhentai(query),
    ehentai: compileEhentai(query),
  };
}

function laneErrorInfo(error: unknown): { phase: LanePhase; message: string; retryable: boolean } {
  if (error instanceof EhentaiUpstreamError) {
    switch (error.kind) {
      case 'rate-limited':
        return { phase: 'rate-limited', message: 'E-Hentai is rate-limiting searches. Try again in a few minutes.', retryable: true };
      case 'quota':
        return { phase: 'rate-limited', message: 'The E-Hentai quota is exhausted for this account.', retryable: false };
      case 'denied':
        return { phase: 'failed', message: 'The E-Hentai session was rejected. Re-test or re-save the account in Settings → Downloader.', retryable: false };
      case 'unavailable':
      case 'timeout':
        return { phase: 'unavailable', message: 'E-Hentai is unreachable right now.', retryable: true };
      case 'parse':
        return { phase: 'failed', message: 'E-Hentai returned an unexpected response.', retryable: true };
      default:
        return { phase: 'failed', message: 'The E-Hentai search failed.', retryable: true };
    }
  }
  if (error instanceof DOMException && error.name === 'AbortError') {
    return { phase: 'unavailable', message: 'The search timed out.', retryable: true };
  }
  return { phase: 'failed', message: 'The provider search failed. You can retry this source.', retryable: true };
}

function withDeadline<T>(promise: Promise<T>, ms: number, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const fail = (error: Error) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(error);
    };
    const timer = setTimeout(() => fail(new DOMException('lane deadline', 'AbortError')), ms);
    const onAbort = () => fail(new DOMException('aborted', 'AbortError'));
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      fail,
    );
  });
}

const hasContinuation = (lane: LaneState): boolean =>
  lane.continuation.offset !== undefined || lane.continuation.cursor !== undefined;

/**
 * Fetch one bounded chunk into a lane. Terminal applicability checks run
 * before any network work: unconfigured accounts and uncompilable queries
 * never reach the provider.
 */
async function fetchLane(session: UnifiedSession, lane: LaneState, signal: AbortSignal): Promise<void> {
  const compiled = session.compiled[lane.source];
  if (compiled.unsupported) {
    lane.phase = 'unsupported-query';
    lane.message = compiled.unsupported;
    lane.retryable = false;
    return;
  }
  if (lane.source === 'ehentai' && !isAccountConfigured()) {
    lane.phase = 'not-configured';
    lane.message = 'Save your E-Hentai/ExHentai account under Settings → Downloader to search it here.';
    lane.retryable = false;
    return;
  }
  if (lane.source === 'ehentai' && compiled.language && EHENTAI_LANGUAGE_IDS[compiled.language] === undefined) {
    lane.phase = 'unsupported-query';
    lane.message = `E-Hentai/ExHentai does not support the language “${compiled.language}”.`;
    lane.retryable = false;
    return;
  }
  const provider = getDoujinProvider(lane.source)!;
  const limit = Math.min(Math.max(1, DEFAULT_LIMIT), MAX_LIMIT);
  const opts = lane.source === 'ehentai' && compiled.language ? { language: compiled.language } : undefined;
  const fetchChunk = async (): Promise<SearchChunk<DoujinSearchResult>> => {
    if (provider.searchChunk) {
      return provider.searchChunk(compiled.query, (lane.continuation.cursor as SearchCursor | undefined) ?? null, limit, 'default', opts, signal);
    }
    // Offset-based sources (hitomi/nhentai): a bounded slice of the exact
    // page they already expose; the continuation is a server-held offset.
    const offset = lane.continuation.offset ?? 0;
    const page = await provider.searchPage!(compiled.query, offset, limit, 'default');
    const exhausted = offset + limit >= page.total;
    return {
      items: page.items,
      nextCursor: exhausted ? null : String(offset + page.items.length),
      exhausted,
      total: page.total,
    };
  };
  try {
    const chunk = await withDeadline(fetchChunk(), LANE_DEADLINE_MS, signal);
    for (const item of chunk.items) {
      const pub = toPublicSearchResult(rewriteDoujinCover(item));
      if (!pub) continue;
      lane.buffer.push({ pub, rank: ++lane.rank });
    }
    lane.continuation = chunk.nextCursor === null ? {} : lane.source === 'ehentai' ? { cursor: chunk.nextCursor } : { offset: Number(chunk.nextCursor) };
    lane.phase = chunk.exhausted ? 'exhausted' : 'success';
    lane.retryable = false;
  } catch (error) {
    const info = laneErrorInfo(error);
    lane.phase = info.phase;
    lane.message = info.message;
    lane.retryable = info.retryable && lane.retriesUsed < LANE_RETRY_LIMIT;
  }
}

// ---------------- grouping / placement ----------------

function toVariant(pub: PublicDoujinSearchResult, rank: number): GalleryVariant {
  return {
    source: pub.source,
    galleryId: pub.galleryId,
    ...(pub.site ? { site: pub.site } : {}),
    title: pub.title,
    coverUrl: pub.coverUrl,
    url: pub.url,
    artists: pub.artists,
    language: pub.language,
    pageCount: pub.pageCount,
    uploadedAt: pub.uploadedAt,
    providerPosition: rank,
  };
}

function createEntry(session: UnifiedSession, cand: Candidate): UnifiedSearchEntry {
  session.seq += 1;
  const entryId = `e${session.seq.toString(36)}-${cand.pub.source}`;
  const entry: UnifiedSearchEntry = { entryId, primary: cand.pub, variants: [toVariant(cand.pub, cand.rank)] };
  session.entries.set(entryId, entry);
  return entry;
}

function addVariant(session: UnifiedSession, entryId: string, cand: Candidate): void {
  const entry = session.entries.get(entryId);
  if (!entry) return;
  entry.variants.push(toVariant(cand.pub, cand.rank));
  if (session.delivered.has(entryId)) session.pendingUpdates.add(entryId);
}

/**
 * Place one candidate: exact identity coalesces first, then the strict
 * fingerprint. Returns the (possibly pre-existing) entry.
 */
function placeCandidate(session: UnifiedSession, cand: Candidate): { entry: UnifiedSearchEntry; fresh: boolean } {
  const ident = identityKey(cand.pub.source, cand.pub.galleryId);
  const existingId = session.identityToEntry.get(ident);
  if (existingId) {
    addVariant(session, existingId, cand);
    return { entry: session.entries.get(existingId)!, fresh: false };
  }
  const fp = fingerprint(cand.pub);
  if (fp) {
    const groupId = session.fingerprintToEntry.get(fp);
    if (groupId) {
      session.identityToEntry.set(ident, groupId);
      addVariant(session, groupId, cand);
      return { entry: session.entries.get(groupId)!, fresh: false };
    }
  }
  if (session.entries.size >= MAX_ENTRIES_PER_SESSION) {
    // Session cap: keep serving, but stop grouping new cards from here on.
  }
  const entry = createEntry(session, cand);
  session.identityToEntry.set(ident, entry.entryId);
  if (fp) session.fingerprintToEntry.set(fp, entry.entryId);
  return { entry, fresh: true };
}

// ---------------- page production ----------------

const TERMINAL_PHASES: readonly string[] = ['exhausted', 'failed', 'unavailable', 'not-configured', 'rate-limited', 'unsupported-query', 'not-applicable'];

function allLanesSettled(session: UnifiedSession): boolean {
  return session.lanes.every((lane) =>
    lane.buffer.length === 0 &&
    (TERMINAL_PHASES.includes(lane.phase) || (lane.phase === 'success' && !hasContinuation(lane)))
  );
}

async function producePage(session: UnifiedSession, limit: number, signal: AbortSignal, retrySource?: DoujinSource): Promise<UnifiedSearchPage> {
  session.lastUsedAt = Date.now();
  assertSessionLive(session, session.context.principal);

  // Optional scoped retry: one failed/unavailable lane, at most once each.
  // A retry re-fetches only that lane and merges its new results into the
  // session; every other lane keeps its pending state for the next
  // continuation request.
  let retryLane: LaneState | null = null;
  if (retrySource) {
    const lane = session.lanes.find((l) => l.source === retrySource);
    if (lane && (lane.phase === 'failed' || lane.phase === 'unavailable' || lane.phase === 'rate-limited') && lane.retryable && lane.retriesUsed < LANE_RETRY_LIMIT) {
      lane.retriesUsed += 1;
      lane.phase = 'idle';
      lane.message = undefined;
      lane.retryable = false;
      retryLane = lane;
    } else if (lane) {
      lane.retryable = false;
    }
  }

  if (retryLane) {
    await fetchLane(session, retryLane, signal);
    const items: UnifiedSearchEntry[] = [];
    let taken = 0;
    while (retryLane.buffer.length > 0 && taken < limit) {
      const cand = retryLane.buffer.shift()!;
      const { entry, fresh } = placeCandidate(session, cand);
      if (fresh && !session.delivered.has(entry.entryId)) {
        session.delivered.add(entry.entryId);
        items.push(entry);
        taken += 1;
      }
    }
    return finishPage(session, items);
  }

  // First chunks for all idle lanes, concurrently (settled-result handling:
  // each lane's outcome is recorded independently).
  const idle = session.lanes.filter((l) => l.phase === 'idle');
  if (idle.length) {
    await Promise.all(idle.map((lane) => fetchLane(session, lane, signal)));
  }

  const items: UnifiedSearchEntry[] = [];
  let extraChunks = 0;
  for (;;) {
    let consumed = 0;
    for (const lane of session.lanes) {
      if (items.length >= limit) break;
      if ((lane.phase === 'success' || lane.phase === 'exhausted') && lane.buffer.length) {
        const cand = lane.buffer.shift()!;
        const { entry, fresh } = placeCandidate(session, cand);
        if (fresh && !session.delivered.has(entry.entryId)) {
          session.delivered.add(entry.entryId);
          items.push(entry);
        }
        consumed += 1;
      }
    }
    if (items.length >= limit || allLanesSettled(session)) break;
    // Buffers with leftovers are consumed on the next round without fetching.
    const buffered = session.lanes.some((l) => (l.phase === 'success' || l.phase === 'exhausted') && l.buffer.length > 0);
    if (buffered) continue;
    const needing = session.lanes.filter((l) => l.phase === 'success' && l.buffer.length === 0 && hasContinuation(l));
    if (!needing.length || extraChunks >= MAX_EXTRA_CHUNKS_PER_REQUEST) break;
    extraChunks += 1;
    const before = session.entries.size;
    await Promise.all(needing.map((lane) => fetchLane(session, lane, signal)));
    // Nothing consumed and the fetches added nothing: stop rather than spin.
    if (!consumed && session.entries.size === before && needing.every((l) => l.buffer.length === 0 && l.phase !== 'success')) break;
  }

  return finishPage(session, items);
}

function finishPage(session: UnifiedSession, items: UnifiedSearchEntry[]): UnifiedSearchPage {
  const updates: UnifiedSearchEntry[] = [];
  for (const entryId of session.pendingUpdates) {
    const entry = session.entries.get(entryId);
    if (!entry) continue;
    // Variants of entries delivered in this same response are already
    // reflected in `items`; only announce updates for earlier deliveries.
    if (items.some((e) => e.entryId === entryId)) continue;
    updates.push(entry);
  }
  session.pendingUpdates.clear();

  const providers = session.lanes.map((lane): ProviderSearchStatus => ({
    source: lane.source,
    status: (lane.phase === 'idle' ? 'success' : lane.phase) as ProviderLaneStatus,
    ...(lane.message ? { message: lane.message } : {}),
    retryable: lane.retryable,
  }));

  // A lane that never ran (unconfigured account, uncompilable query, input
  // that does not apply) cannot block an exact total; failed lanes can.
  const applicable = session.lanes.filter((l) => !['not-applicable', 'not-configured', 'unsupported-query'].includes(l.phase));
  const allExhausted = applicable.length > 0 && applicable.every((l) => l.phase === 'exhausted' && l.buffer.length === 0);
  // hasMore = another page can deliver new entries without an explicit retry.
  // Retryable failed lanes are surfaced through their status chips instead.
  const canYieldMore = session.lanes.some((l) =>
    ((l.phase === 'success' || l.phase === 'exhausted') && l.buffer.length > 0) ||
    (l.phase === 'success' && hasContinuation(l)));
  const hasMore = canYieldMore && session.entries.size < MAX_ENTRIES_PER_SESSION;
  const retryablePending = session.lanes.some((l) => l.retryable && (l.phase === 'failed' || l.phase === 'unavailable' || l.phase === 'rate-limited'));
  const nextCursor = hasMore || retryablePending ? issueCursor() : null;
  const response: UnifiedSearchPage = {
    items,
    updates,
    nextCursor,
    hasMore,
    loadedUniqueCount: session.entries.size,
    providers,
    ...(allExhausted ? { totalUnique: session.entries.size } : {}),
  };

  // Cursor bookkeeping: the cursor that produced this page becomes replayable;
  // the issued cursor names the next state.
  const producedFrom = session.nextCursor;
  if (producedFrom !== null) {
    session.servedCursor = producedFrom;
    registerKey(session, producedFrom);
  }
  session.lastResponse = response;
  session.nextCursor = nextCursor;
  if (nextCursor) registerKey(session, nextCursor);
  evictExpired();
  return response;
}

// ---------------- URL/ID resolution (single-provider, no broadcast) ----------------

async function produceUrlPage(source: DoujinSource, url: string, signal: AbortSignal): Promise<UnifiedSearchPage> {
  const provider = getDoujinProvider(source)!;
  const states: Record<DoujinSource, { phase: LanePhase; message?: string }> = {
    hitomi: { phase: 'not-applicable', message: 'This is a gallery URL for another source; it only resolves on its own provider.' },
    nhentai: { phase: 'not-applicable', message: 'This is a gallery URL for another source; it only resolves on its own provider.' },
    ehentai: { phase: 'not-applicable', message: 'This is a gallery URL for another source; it only resolves on its own provider.' },
  };
  let gallery: DoujinSearchResult;
  try {
    gallery = await withDeadline(provider.getGallery(url), LANE_DEADLINE_MS, signal);
  } catch (error) {
    const info = laneErrorInfo(error);
    states[source] = { phase: info.phase === 'rate-limited' ? 'rate-limited' : 'failed', message: info.message };
    throw new UnifiedQueryError(info.message);
  }
  const pub = toPublicSearchResult(rewriteDoujinCover(gallery));
  if (!pub) throw new UnifiedQueryError('The gallery could not be resolved.');
  states[source] = { phase: 'exhausted' };
  const entry: UnifiedSearchEntry = { entryId: `e1-${source}`, primary: pub, variants: [toVariant(pub, 1)] };
  return {
    items: [entry],
    updates: [],
    nextCursor: null,
    hasMore: false,
    loadedUniqueCount: 1,
    providers: SOURCE_ORDER.map((s): ProviderSearchStatus => ({
      source: s,
      status: states[s].phase as ProviderLaneStatus,
      ...(states[s].message ? { message: states[s].message } : {}),
      retryable: false,
    })),
    totalUnique: 1,
  };
}

// ---------------- public entry point ----------------

export interface UnifiedSearchRequest {
  query?: string;
  cursor?: string;
  retry?: string;
  limit?: number;
  principal: string | null;
}

export async function runUnifiedSearch(req: UnifiedSearchRequest, signal: AbortSignal): Promise<UnifiedSearchPage> {
  evictExpired();

  if (!req.cursor) {
    if (!req.query?.trim()) throw new UnifiedQueryError('Enter a search query.');
    const classification = classifyRawQuery(req.query);
    if (classification.kind === 'ambiguous-id') {
      throw new UnifiedQueryError('A bare numeric ID is ambiguous — every source uses numeric IDs. Open native Search and choose the source, or paste the full gallery URL.');
    }
    if (classification.kind === 'url') {
      return produceUrlPage(classification.source, classification.url, signal);
    }
    const parsed = parseCommonQuery(req.query);
    if (parsed.error || !parsed.query) throw new UnifiedQueryError(parsed.error ?? 'Enter a search query.');
    const session = newSession(req.query, req.principal, compileLanes(parsed.query));
    return producePage(session, req.limit ?? DEFAULT_LIMIT, signal);
  }

  const session = sessions.get(req.cursor);
  if (!session) {
    throw new UnifiedSessionError('This search session has expired. Your query is kept — start the search again.', 'expired');
  }
  assertSessionLive(session, req.principal);
  if (session.inflight) return session.inflight;
  if (session.servedCursor === req.cursor && session.lastResponse) {
    // Repeating the last served cursor replays the same response.
    return session.lastResponse;
  }
  if (session.nextCursor !== req.cursor) {
    throw new UnifiedSessionError('This continuation is stale. Start the search again to avoid skipping results.', 'stale');
  }
  const retrySource = req.retry && (SOURCE_ORDER as string[]).includes(req.retry) ? (req.retry as DoujinSource) : undefined;
  const work = producePage(session, req.limit ?? DEFAULT_LIMIT, signal, retrySource);
  session.inflight = work;
  try {
    return await work;
  } finally {
    session.inflight = null;
  }
}
