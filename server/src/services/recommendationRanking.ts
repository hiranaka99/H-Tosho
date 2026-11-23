import type { DoujinGallery, DoujinSearchResult } from '../downloader/types.js';
import type { RecommendationItem } from './recommendations.js';
import { isBoilerplateTag } from './recommendationProfile.js';

export interface Candidate {
  result: DoujinSearchResult;
  score: number;
  reasons: string[];
  matched: Set<string>;
}

export interface RankingOptions {
  /** Soft negative weights from dismissed galleries (`artist:...`, `tag:...`). */
  dislikedTerms?: Record<string, number>;
  /** Real catalog counts for tags (`tag:...` -> gallery count) from Hitomi tagindex. */
  globalTagCounts?: Map<string, number>;
  /** Median page count of the user's library for subtle length affinity. */
  preferredPageCount?: number | null;
}

const normalized = (value: string): string => value.trim().toLowerCase();
const galleryKey = (result: DoujinSearchResult): string => `${result.source}:${result.galleryId}`;
const artistKeys = (result: DoujinSearchResult): string[] => [...new Set(result.artists.map(normalized).filter(Boolean))];
const GLOBAL_CATALOG_REF = 250_000;

/** Recompute rather than accumulate: a gallery found by several queries gets one language bonus. */
export function rankCandidates(
  candidates: Candidate[],
  termWeights: Map<string, number>,
  preferredLanguage: string | null,
  options?: RankingOptions,
): void {
  const tagFrequency = new Map<string, number>();
  for (const candidate of candidates) {
    const tags = new Set(candidate.result.tags.map((tag) => `tag:${normalized(tag)}`));
    for (const term of candidate.matched) if (term.startsWith('tag:')) tags.add(term);
    for (const tag of tags) tagFrequency.set(tag, (tagFrequency.get(tag) ?? 0) + 1);
  }
  const maxRarity = Math.log2(1 + candidates.length);
  const maxGlobalRarity = Math.log2(1 + GLOBAL_CATALOG_REF);
  // Only add a language bonus when candidates actually vary in language; adding a
  // constant to every single candidate compresses roulette score ratios.
  const hitomiCandidates = candidates.filter((c) => c.result.source === 'hitomi');
  const hasMixedLanguages = Boolean(preferredLanguage)
    && hitomiCandidates.some((c) => normalized(c.result.language ?? '') === preferredLanguage)
    && hitomiCandidates.some((c) => normalized(c.result.language ?? '') !== preferredLanguage);

  const nowMs = Date.now();
  const disliked = options?.dislikedTerms;
  const globalCounts = options?.globalTagCounts;
  const preferredPages = options?.preferredPageCount ?? null;

  for (const candidate of candidates) {
    let artistSeriesScore = 0;
    let tagScore = 0;
    let matchedDistinctiveTags = 0;
    const matchedKinds = new Set<string>();

    for (const term of candidate.matched) {
      const weight = termWeights.get(term);
      if (weight === undefined) continue;
      let contribution = 1 + Math.log2(1 + Math.max(0, weight));
      if (term.startsWith('tag:')) {
        const tagName = term.slice(4);
        const globalCount = globalCounts?.get(term);
        if (globalCount && globalCount > 0) {
          contribution *= Math.min(1, Math.max(0.2, Math.log2(1 + GLOBAL_CATALOG_REF / globalCount) / maxGlobalRarity));
        } else {
          // Smoothed inverse document frequency: a ubiquitous tag contributes
          // less than a distinctive tag with the same ownership frequency.
          const frequency = tagFrequency.get(term) ?? 1;
          contribution *= Math.log2(1 + candidates.length / frequency) / maxRarity;
        }
        if (isBoilerplateTag(tagName)) {
          contribution *= 0.25;
        } else {
          matchedDistinctiveTags += 1;
          matchedKinds.add('tag');
        }
        tagScore += contribution;
      } else {
        matchedKinds.add(term.startsWith('artist:') ? 'artist' : 'series');
        artistSeriesScore += contribution;
      }
    }

    // Tag precision: reward focused doujinshi over 30-tag "kitchen-sink" anthologies
    // when both match the same number of taste tags.
    const distinctiveResultTags = candidate.result.tags.filter((tag) => !isBoilerplateTag(tag)).length;
    if (tagScore > 0 && distinctiveResultTags > 4) {
      const precision = Math.min(1, matchedDistinctiveTags / distinctiveResultTags);
      tagScore *= 0.72 + 0.42 * precision;
    }

    let score = artistSeriesScore + tagScore;

    // Multi-axis synergy: matching both artist/series AND distinctive tags is a stronger signal.
    if (matchedKinds.size >= 2) score += 0.75;

    if (hasMixedLanguages && preferredLanguage && candidate.result.source === 'hitomi'
      && normalized(candidate.result.language ?? '') === preferredLanguage) {
      score += 1.5;
    }

    // Gentle recency and length alignment nudges when richer ranking options are active.
    if (options) {
      if (candidate.result.uploadedAt) {
        const uploadedMs = Date.parse(candidate.result.uploadedAt);
        if (Number.isFinite(uploadedMs) && nowMs - uploadedMs >= 0 && nowMs - uploadedMs <= 90 * 86_400_000) {
          score += 0.25;
        }
      }
      if (preferredPages && preferredPages > 0 && candidate.result.pageCount && candidate.result.pageCount > 0) {
        const ratio = Math.abs(Math.log2(candidate.result.pageCount / preferredPages));
        if (ratio < 0.75) score += 0.25 * (1 - ratio / 0.75);
      }
    }

    // Soft negative penalty from previously dismissed galleries.
    if (disliked) {
      let penalty = 0;
      for (const artist of artistKeys(candidate.result)) {
        const count = disliked[`artist:${artist}`];
        if (count) penalty += Math.min(1.5, count * 0.5);
      }
      for (const tag of candidate.result.tags) {
        if (isBoilerplateTag(tag)) continue;
        const count = disliked[`tag:${normalized(tag)}`];
        if (count) penalty += Math.min(1.0, count * 0.3);
      }
      if (penalty > 0) {
        score = Math.max(score > 0 ? 0.05 : 0, score - Math.min(3, penalty));
      }
    }

    candidate.score = score;
  }
}

// Explicit, trailing language labels only. Never strip arbitrary bracketed
// text, punctuation, chapter/volume numbers, or fuzzy-match similar titles.
const LANGUAGE_SUFFIX = /\s*(?:\[(?:english|japanese|chinese|korean|spanish|french|german|italian|portuguese|russian|thai|vietnamese|indonesian|polish|turkish|dutch|hungarian|ukrainian|czech|arabic)\]|\((?:english|japanese|chinese|korean|spanish|french|german|italian|portuguese|russian|thai|vietnamese|indonesian|polish|turkish|dutch|hungarian|ukrainian|czech|arabic)\))\s*$/i;
// Known edition qualifiers that commonly follow a language label on Hitomi.
const EDITION_QUALIFIER = /\s*(?:\[(?:decensored|uncensored|rewrite|dl\s*edition|colorized)\]|\((?:decensored|uncensored|rewrite|dl\s*edition|colorized)\))\s*$/i;

/**
 * Search results expose gallery IDs, not a provider's stable cross-edition work
 * ID. The conservative fallback merges only explicitly language-suffixed
 * titles (optionally followed by a known edition qualifier such as [Decensored])
 * with identical remaining text, identical nonempty artist sets, and
 * identical positive page counts. Unsuffixed titles or incomplete metadata
 * retain gallery identity; a generic title alone never establishes a work.
 */
export function workKey(result: DoujinSearchResult): string {
  const artists = artistKeys(result).sort();
  if (!artists.length || !result.pageCount || result.pageCount <= 0 || !Number.isFinite(result.pageCount)) return galleryKey(result);
  let stripped = result.title;
  while (EDITION_QUALIFIER.test(stripped)) stripped = stripped.replace(EDITION_QUALIFIER, '');
  if (!LANGUAGE_SUFFIX.test(stripped)) return galleryKey(result);
  const title = stripped.replace(LANGUAGE_SUFFIX, '').trim();
  if (!title) return galleryKey(result);
  return `edition:${JSON.stringify([title, artists, result.pageCount])}`;
}

function overlapTerms(result: DoujinSearchResult, reasons: string[], matched?: Set<string>): Set<string> {
  const terms = new Set<string>();
  for (const tag of result.tags) {
    if (!isBoilerplateTag(tag)) terms.add(`tag:${normalized(tag)}`);
  }
  for (const term of matched ?? []) {
    if (term.startsWith('series:')) terms.add(term);
    else if (term.startsWith('tag:') && !isBoilerplateTag(term.slice(4))) terms.add(term);
  }
  for (const reason of reasons) {
    if (reason.startsWith('tag ') || reason.startsWith('series ')) {
      const separator = reason.indexOf(' ');
      const kind = reason.slice(0, separator);
      const val = normalized(reason.slice(separator + 1));
      if (kind === 'series' || !isBoilerplateTag(val)) terms.add(`${kind}:${val}`);
    }
  }
  const gallery = result as Partial<DoujinGallery>;
  if (gallery.series) terms.add(`series:${normalized(gallery.series)}`);
  for (const series of gallery.parodies ?? []) terms.add(`series:${normalized(series)}`);
  return terms;
}

/**
 * Seeded roulette sampling without replacement. Actual artist identities and
 * work identities are hard exclusions across passes; tag/series repetition
 * only reduces draw weight, so shared tastes cannot prevent filling the set.
 * Returns new picks only; callers carry earlier picks in alreadySelected.
 */
export function selectRecommendations(
  candidates: Candidate[],
  count: number,
  rng: () => number,
  alreadySelected: RecommendationItem[] = [],
): RecommendationItem[] {
  const artists = new Set<string>();
  const galleries = new Set<string>();
  const works = new Set<string>();
  const termCounts = new Map<string, number>();
  const consume = (result: DoujinSearchResult, terms: Set<string>): void => {
    for (const artist of artistKeys(result)) artists.add(artist);
    galleries.add(galleryKey(result));
    works.add(workKey(result));
    for (const term of terms) termCounts.set(term, (termCounts.get(term) ?? 0) + 1);
  };
  for (const item of alreadySelected) consume(item, overlapTerms(item, item.reasons));
  const pool = candidates.map((candidate) => ({
    candidate,
    artists: artistKeys(candidate.result),
    gallery: galleryKey(candidate.result),
    work: workKey(candidate.result),
    terms: overlapTerms(candidate.result, candidate.reasons, candidate.matched),
  }));
  const out: RecommendationItem[] = [];
  while (out.length < count) {
    const eligible = pool.filter((entry) => !galleries.has(entry.gallery) && !works.has(entry.work)
      && !entry.artists.some((artist) => artists.has(artist)));
    if (!eligible.length) break;
    let total = 0;
    const weights = eligible.map((entry) => {
      let overlap = 0;
      for (const term of entry.terms) overlap += termCounts.get(term) ?? 0;
      const weight = Math.max(0, entry.candidate.score) / (1 + overlap);
      total += weight;
      return weight;
    });
    let chosenIndex = eligible.length - 1;
    if (total > 0) {
      let draw = rng() * total;
      for (let i = 0; i < eligible.length; i++) {
        draw -= weights[i];
        if (weights[i] > 0 && draw < 0) {
          chosenIndex = i;
          break;
        }
      }
    } else chosenIndex = Math.floor(rng() * eligible.length);
    const chosen = eligible[chosenIndex];
    consume(chosen.candidate.result, chosen.terms);
    out.push({ ...chosen.candidate.result, reasons: [...chosen.candidate.reasons] });
  }
  return out;
}

/**
 * Balanced slot selection: reserves up to a third of slots for artist/series
 * anchor matches when available, then fills the remaining slots from the full
 * ranked pool while preserving artist/work uniqueness and tag diversity.
 */
export function selectBalancedRecommendations(
  candidates: Candidate[],
  count: number,
  rng: () => number,
  alreadySelected: RecommendationItem[] = [],
): RecommendationItem[] {
  if (count <= 0 || !candidates.length) return [];
  const anchors = candidates.filter((c) => [...c.matched].some((t) => t.startsWith('artist:') || t.startsWith('series:')));
  const nonAnchors = candidates.filter((c) => ![...c.matched].some((t) => t.startsWith('artist:') || t.startsWith('series:')));
  if (!anchors.length || !nonAnchors.length) {
    return selectRecommendations(candidates, count, rng, alreadySelected);
  }
  const anchorBudget = Math.min(anchors.length, Math.max(1, Math.floor(count / 3)));
  const anchorPicks = selectRecommendations(anchors, anchorBudget, rng, alreadySelected);
  const rest = selectRecommendations(candidates, count - anchorPicks.length, rng, [...alreadySelected, ...anchorPicks]);
  // Interleave anchor and taste picks gently instead of clumping all artist picks in row 1.
  const combined = [...anchorPicks, ...rest];
  for (let i = combined.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [combined[i], combined[j]] = [combined[j], combined[i]];
  }
  return combined;
}
