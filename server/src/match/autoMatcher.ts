import { getProvider } from '../providers/registry.js';
import type { MetadataProvider, SearchResult, SeriesMetadata, MediaType } from '../providers/types.js';
import { AUTO_MATCH_THRESHOLD, canonicalTitle, scoreCanonical, titleSearchParts } from './normalize.js';
import type { KavitaSeries } from '../kavita/types.js';

export interface CandidateMatch {
  providerId: string;
  providerSeriesId: string;
  title: string;
  type: string;
  year?: number;
  coverUrl?: string;
  summary?: string;
  score: number;
}

export interface MatchOutcome {
  matched: boolean;
  best: CandidateMatch | null;
  candidates: CandidateMatch[];
  searchedProviders: string[];
  errors: Record<string, string>;
}

export interface AutoMatchOptions {
  /** Ordered provider ids to evaluate. Missing/empty = use stored priorities. */
  providerOrder?: string[];
  /** Media type hint (MANGA | NOVEL | COMIC | WEBTOON). */
  type?: MediaType;
  /** Search query override (defaults to series name). */
  query?: string;
  /** Threshold override. */
  threshold?: number;
  /** Search every provider even after a confident match (interactive identify). Background auto-match keeps the early exit for speed. */
  searchAll?: boolean;
  /** Credentials map: providerId -> Record<string,string>. */
  credentials: Record<string, Record<string, string>>;
  enabledProviders: string[];
  signal?: AbortSignal;
}

/**
 * Score a search result against the series' canonical name across every known
 * title variant (display title + provider alternates). Returns the best score
 * and the variant that achieved it, so candidates display the name the folder
 * actually matches. Ties keep the display title. The series name is
 * canonicalized once per autoMatch call, not per candidate/alt title.
 */
function bestVariant(seriesCanonical: string, r: SearchResult): { score: number; title: string } {
  let score = scoreCanonical(seriesCanonical, canonicalTitle(r.title));
  let title = r.title;
  for (const alt of r.altTitles ?? []) {
    const s = scoreCanonical(seriesCanonical, canonicalTitle(alt));
    if (s > score) {
      score = s;
      title = alt;
    }
  }
  return { score, title };
}

/**
 * Auto-matcher: evaluates providers in priority order and returns the best
 * candidate above threshold. Stops early on a high-confidence exact match.
 * When the full series name scores nothing usable, retries each
 * separator-delimited part of the name (see titleSearchParts) so compound
 * Kavita names like "Aizome - Fill With LOVE" still find their bare title.
 */
export async function autoMatch(
  series: Pick<KavitaSeries, 'name' | 'id'>,
  options: AutoMatchOptions,
): Promise<MatchOutcome> {
  const threshold = options.threshold ?? AUTO_MATCH_THRESHOLD;
  const order = (options.providerOrder ?? []).filter((id) =>
    options.enabledProviders.includes(id),
  );
  const query = options.query ?? series.name;
  // Canonicalize the series name once; bestVariant scores every candidate
  // against this instead of re-canonicalizing per candidate and per alt title.
  const seriesCanonical = canonicalTitle(series.name);
  const candidates: CandidateMatch[] = [];
  const searchedProviders: string[] = [];
  const errors: Record<string, string> = {};

  const searchOneProvider = async (providerId: string, searchQuery: string): Promise<CandidateMatch[]> => {
    options.signal?.throwIfAborted();
    const provider = getProvider(providerId);
    if (!provider) return [];
    if (options.type && !provider.supportedTypes.includes(options.type)) return [];
    try {
      provider.setCredentials(options.credentials[providerId] ?? {});
      const results = await provider.search(searchQuery, options.type, options.signal);
      if (!searchedProviders.includes(providerId)) searchedProviders.push(providerId);
      const out: CandidateMatch[] = [];
      for (const r of results) {
        if (!r.title) continue;
        // Score against every known title variant: folder names often match
        // a romanized or alternate title the display title misses. The best
        // scoring variant becomes the candidate's displayed title.
        const { score, title } = bestVariant(seriesCanonical, r);
        out.push({
          providerId: provider.id,
          providerSeriesId: r.providerSeriesId,
          title,
          type: r.type,
          year: r.year,
          coverUrl: r.coverUrl,
          summary: r.summary,
          score,
        });
      }
      return out;
    } catch (err) {
      options.signal?.throwIfAborted();
      errors[providerId] = err instanceof Error ? err.message : String(err);
      return [];
    }
  };

  const searchProviders = async (searchQuery: string): Promise<void> => {
    if (options.searchAll) {
      const perProvider = await Promise.all(order.map((providerId) => searchOneProvider(providerId, searchQuery)));
      options.signal?.throwIfAborted();
      for (const list of perProvider) candidates.push(...list);
      return;
    }
    for (const providerId of order) {
      const found = await searchOneProvider(providerId, searchQuery);
      candidates.push(...found);
      // Early exit: a confident exact/near-exact match from the top provider.
      let topScoreFound = -1;
      for (const item of found) {
        if (item.score > topScoreFound) topScoreFound = item.score;
      }
      if (topScoreFound >= 0.97) break;
    }
  };

  await searchProviders(query);

  // No confident match with the full series name? Kavita names often concatenate
  // title + subtitle ("Aizome - Fill With LOVE") and provider title search can't
  // see through the compound string — retry each separator-delimited part so bare
  // titles still surface. Only runs when the first pass found nothing usable.
  const topScore = candidates.reduce((m, c) => Math.max(m, c.score), 0);
  if (topScore < threshold) {
    for (const part of titleSearchParts(query)) {
      if (part === query) continue;
      await searchProviders(part);
    }
  }
  // The same title can surface from multiple live searches (full name plus
  // fallback part queries). Collapse duplicates by provider + series id,
  // keeping the higher score.
  const deduped = new Map<string, CandidateMatch>();
  for (const c of candidates) {
    const key = `${c.providerId}:${c.providerSeriesId}`;
    const prev = deduped.get(key);
    if (!prev || c.score > prev.score) deduped.set(key, c);
  }
  const merged = [...deduped.values()];
  // Exact score ties (e.g. two containment matches at 0.92) are broken by
  // token overlap with the series name, so a title sharing more of the query
  // wins regardless of provider priority or catalog merge order.
  const queryTokens = new Set((query === series.name ? seriesCanonical : canonicalTitle(query)).split(' '));
  const sharedTokenCount = new Map<string, number>();
  const sharedTokens = (c: CandidateMatch): number => {
    let n = sharedTokenCount.get(c.title);
    if (n === undefined) {
      const tokens = new Set(canonicalTitle(c.title).split(' '));
      n = 0;
      for (const w of queryTokens) if (tokens.has(w)) n++;
      sharedTokenCount.set(c.title, n);
    }
    return n;
  };
  merged.sort((a, b) => b.score - a.score || sharedTokens(b) - sharedTokens(a));
  const best = merged[0] ?? null;
  return {
    matched: !!best && best.score >= threshold,
    best,
    candidates: merged.slice(0, 10),
    searchedProviders,
    errors,
  };
}

/**
 * Fetch full metadata from a single provider for a confirmed match. Matching
 * and sync are 1:1 with providers, so no cross-provider blending happens.
 */
export async function fetchProviderMetadata(
  providerId: string,
  providerSeriesId: string,
  credentials: Record<string, Record<string, string>>,
  signal?: AbortSignal,
): Promise<SeriesMetadata> {
  const provider = getProvider(providerId);
  if (!provider) throw new Error(`Unknown provider: ${providerId}`);
  provider.setCredentials(credentials[providerId] ?? {});
  return provider.getSeriesMetadata(providerSeriesId, signal);
}

/**
 * Use the provider's batch metadata fetcher unless single-item `getSeriesMetadata`
 * was monkey-patched directly on the instance (e.g. test mocks) without its batch peer.
 */
export function canBatchProviderMetadata(provider: MetadataProvider): boolean {
  return typeof provider.getSeriesMetadataBatch === 'function'
    && (Object.prototype.hasOwnProperty.call(provider, 'getSeriesMetadataBatch')
      || !Object.prototype.hasOwnProperty.call(provider, 'getSeriesMetadata'));
}

export async function fetchProviderMetadataBatch(
  providerId: string,
  providerSeriesIds: string[],
  credentials: Record<string, Record<string, string>>,
  signal?: AbortSignal,
  opts?: { skipVolumeCovers?: ReadonlySet<string> },
): Promise<Map<string, SeriesMetadata> | null> {
  const provider = getProvider(providerId);
  if (!provider) throw new Error(`Unknown provider: ${providerId}`);
  provider.setCredentials(credentials[providerId] ?? {});
  if (!canBatchProviderMetadata(provider)) return null;
  return provider.getSeriesMetadataBatch!(providerSeriesIds, signal, opts);
}
