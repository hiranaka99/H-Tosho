import { getProvider } from '../providers/registry.js';
import type { SearchResult, SeriesMetadata, MediaType } from '../providers/types.js';
import { AUTO_MATCH_THRESHOLD, canonicalTitle, titleScore, titleSearchParts } from './normalize.js';
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
  fromProvider: SearchResult;
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
  /** Credentials map: providerId -> Record<string,string>. */
  credentials: Record<string, Record<string, string>>;
  enabledProviders: string[];
  /**
   * Pre-scored candidates from non-live sources (e.g. the local MangaDex adult
   * catalog). Merged into the candidate pool after provider searches; scored
   * with the same titleScore machinery so selection logic is unchanged.
   */
  extraCandidates?: CandidateMatch[];
}

/**
 * Score a search result against the series name across every known title
 * variant (display title + provider alternates). Returns the best score and
 * the variant that achieved it, so candidates display the name the folder
 * actually matches. Ties keep the display title.
 */
function bestVariant(seriesName: string, r: SearchResult): { score: number; title: string } {
  let score = titleScore(seriesName, r.title);
  let title = r.title;
  for (const alt of r.altTitles ?? []) {
    const s = titleScore(seriesName, alt);
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
  const candidates: CandidateMatch[] = [];
  const searchedProviders: string[] = [];
  const errors: Record<string, string> = {};

  const searchProviders = async (searchQuery: string): Promise<void> => {
    for (const providerId of order) {
      const provider = getProvider(providerId);
      if (!provider) continue;
      if (options.type && !provider.supportedTypes.includes(options.type)) continue;
      try {
        provider.setCredentials(options.credentials[providerId] ?? {});
        const results = await provider.search(searchQuery, options.type);
        if (!searchedProviders.includes(providerId)) searchedProviders.push(providerId);
        for (const r of results) {
          if (!r.title) continue;
          // Score against every known title variant: folder names often match
          // a romanized or alternate title the display title misses. The best
          // scoring variant becomes the candidate's displayed title.
          const { score, title } = bestVariant(series.name, r);
          candidates.push({
            providerId: provider.id,
            providerSeriesId: r.providerSeriesId,
            title,
            type: r.type,
            year: r.year,
            coverUrl: r.coverUrl,
            summary: r.summary,
            score,
            fromProvider: r,
          });
        }
        // Early exit: a confident exact/near-exact match from the top provider.
        const top = candidates
          .filter((c) => c.providerId === providerId)
          .sort((a, b) => b.score - a.score)[0];
        if (top && top.score >= 0.97) break;
      } catch (err) {
        errors[providerId] = err instanceof Error ? err.message : String(err);
      }
    }
  };

  await searchProviders(query);

  // Merge pre-scored local candidates (e.g. MangaDex adult catalog) into the pool.
  if (options.extraCandidates?.length) candidates.push(...options.extraCandidates);

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
  // The same title can surface from both live search and a local catalog
  // (adult titles are indexed in both). Collapse duplicates by provider +
  // series id, keeping the higher score; ties keep the live result, which
  // was pushed before the catalog merge.
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
  const queryTokens = new Set(canonicalTitle(query).split(' '));
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
 * Fetch + aggregate metadata for a confirmed match: the primary provider
 * supplies the base record, then lower-priority providers are blended in
 * for specific fields according to `fieldConfig` (see aggregation service).
 */
export async function fetchAggregatedMetadata(
  primary: { providerId: string; providerSeriesId: string },
  options: AutoMatchOptions,
  fieldConfig: Record<string, string | null>,
): Promise<SeriesMetadata> {
  const primaryProvider = getProvider(primary.providerId);
  if (!primaryProvider) throw new Error(`Unknown provider: ${primary.providerId}`);
  primaryProvider.setCredentials(options.credentials[primary.providerId] ?? {});
  const base = await primaryProvider.getSeriesMetadata(primary.providerSeriesId);

  // Blend in supplementary fields from other providers per fieldConfig.
  const order = (options.providerOrder ?? []).filter(
    (id) => id !== primary.providerId && options.enabledProviders.includes(id),
  );
  for (const providerId of order) {
    const provider = getProvider(providerId);
    if (!provider) continue;
    // Determine if this provider should supply any field
    const wanted = Object.entries(fieldConfig)
      .filter(([field, pid]) => pid === providerId)
      .map(([field]) => field);
    if (wanted.length === 0) continue;
    try {
      provider.setCredentials(options.credentials[providerId] ?? {});
      // Best-effort id resolution: use primary id string; providers with
      // different id spaces may simply fail and be skipped.
      const meta = await provider.getSeriesMetadata(primary.providerSeriesId);
      for (const field of wanted) {
        if (field === 'summary' && meta.summary) base.summary = meta.summary;
        else if (field === 'cover' && meta.coverUrl) base.coverUrl = meta.coverUrl;
        else if (field === 'volumeCovers' && meta.volumeCovers?.length) base.volumeCovers = meta.volumeCovers;
        else if (field === 'genres' && meta.genres.length) base.genres = mergeLists(base.genres, meta.genres);
        else if (field === 'tags' && meta.tags.length) base.tags = mergeLists(base.tags, meta.tags);
        else if (field === 'writers' && meta.writers.length) base.writers = mergeLists(base.writers, meta.writers);
        else if (field === 'artists' && meta.artists.length) base.artists = mergeLists(base.artists, meta.artists);
        else if (field === 'publishers' && meta.publishers.length) base.publishers = mergeLists(base.publishers, meta.publishers);
        else if (field === 'releaseDate' && meta.releaseDate) base.releaseDate = meta.releaseDate;
        else if (field === 'rating' && meta.rating != null) base.rating = meta.rating;
        else if (field === 'status' && meta.status && meta.status !== 'UNKNOWN') base.status = meta.status;
      }
    } catch {
      // supplementary fetch failed - keep primary data
    }
  }
  return base;
}

function mergeLists(a: string[], b: string[]): string[] {
  const seen = new Set(a.map((x) => x.toLowerCase()));
  const out = [...a];
  for (const item of b) {
    const key = item.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}
