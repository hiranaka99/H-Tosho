import { getProvider } from '../providers/registry.js';
import { AUTO_MATCH_THRESHOLD, titleScore, yearBonus } from './normalize.js';
import type { SearchResult, SeriesMetadata, MediaType } from '../providers/types.js';
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
}

/**
 * Auto-matcher: evaluates providers in priority order and returns the best
 * candidate above threshold. Stops early on a high-confidence exact match.
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

  for (const providerId of order) {
    const provider = getProvider(providerId);
    if (!provider) continue;
    if (options.type && !provider.supportedTypes.includes(options.type)) continue;
    try {
      provider.setCredentials(options.credentials[providerId] ?? {});
      const results = await provider.search(query, options.type);
      searchedProviders.push(providerId);
      for (const r of results) {
        if (!r.title) continue;
        const score = titleScore(series.name, r.title) + yearBonus(undefined, r.year);
        candidates.push({
          providerId: provider.id,
          providerSeriesId: r.providerSeriesId,
          title: r.title,
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

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0] ?? null;
  return {
    matched: !!best && best.score >= threshold,
    best,
    candidates: candidates.slice(0, 10),
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
