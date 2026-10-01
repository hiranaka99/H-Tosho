import type { DoujinGallery, DoujinSearchResult } from '../downloader/types.js';
import type { RecommendationItem } from './recommendations.js';

export interface Candidate {
  result: DoujinSearchResult;
  score: number;
  reasons: string[];
  matched: Set<string>;
}

const normalized = (value: string): string => value.trim().toLowerCase();
const galleryKey = (result: DoujinSearchResult): string => `${result.source}:${result.galleryId}`;
const artistKeys = (result: DoujinSearchResult): string[] => [...new Set(result.artists.map(normalized).filter(Boolean))];

/** Recompute rather than accumulate: a gallery found by several queries gets one language bonus. */
export function rankCandidates(candidates: Candidate[], termWeights: Map<string, number>, preferredLanguage: string | null): void {
  const tagFrequency = new Map<string, number>();
  for (const candidate of candidates) {
    const tags = new Set(candidate.result.tags.map((tag) => `tag:${normalized(tag)}`));
    for (const term of candidate.matched) if (term.startsWith('tag:')) tags.add(term);
    for (const tag of tags) tagFrequency.set(tag, (tagFrequency.get(tag) ?? 0) + 1);
  }
  const maxRarity = Math.log2(1 + candidates.length);
  for (const candidate of candidates) {
    let score = 0;
    for (const term of candidate.matched) {
      const weight = termWeights.get(term);
      if (weight === undefined) continue;
      let contribution = 1 + Math.log2(1 + Math.max(0, weight));
      if (term.startsWith('tag:')) {
        // Smoothed inverse document frequency: a ubiquitous tag contributes
        // less than a distinctive tag with the same ownership frequency.
        const frequency = tagFrequency.get(term) ?? 1;
        contribution *= Math.log2(1 + candidates.length / frequency) / maxRarity;
      }
      score += contribution;
    }
    if (preferredLanguage && candidate.result.source === 'hitomi'
      && normalized(candidate.result.language ?? '') === preferredLanguage) score += 1.5;
    candidate.score = score;
  }
}

// Explicit, trailing language labels only. Never strip arbitrary bracketed
// text, punctuation, chapter/volume numbers, or fuzzy-match similar titles.
const LANGUAGE_SUFFIX = /\s*(?:\[(?:english|japanese|chinese|korean|spanish|french|german|italian|portuguese|russian|thai|vietnamese|indonesian|polish|turkish|dutch|hungarian|ukrainian|czech|arabic)\]|\((?:english|japanese|chinese|korean|spanish|french|german|italian|portuguese|russian|thai|vietnamese|indonesian|polish|turkish|dutch|hungarian|ukrainian|czech|arabic)\))\s*$/i;

/**
 * Search results expose gallery IDs, not a provider's stable cross-edition work
 * ID. The conservative fallback merges only explicitly language-suffixed
 * titles with identical remaining text, identical nonempty artist sets, and
 * identical positive page counts. Unsuffixed titles or incomplete metadata
 * retain gallery identity; a generic title alone never establishes a work.
 */
export function workKey(result: DoujinSearchResult): string {
  const artists = artistKeys(result).sort();
  if (!artists.length || !result.pageCount || result.pageCount <= 0 || !Number.isFinite(result.pageCount)
    || !LANGUAGE_SUFFIX.test(result.title)) return galleryKey(result);
  const title = result.title.replace(LANGUAGE_SUFFIX, '').trim();
  if (!title) return galleryKey(result);
  return `edition:${JSON.stringify([title, artists, result.pageCount])}`;
}

function overlapTerms(result: DoujinSearchResult, reasons: string[], matched?: Set<string>): Set<string> {
  const terms = new Set(result.tags.map((tag) => `tag:${normalized(tag)}`));
  for (const term of matched ?? []) {
    if (term.startsWith('tag:') || term.startsWith('series:')) terms.add(term);
  }
  for (const reason of reasons) {
    if (reason.startsWith('tag ') || reason.startsWith('series ')) {
      const separator = reason.indexOf(' ');
      terms.add(`${reason.slice(0, separator)}:${normalized(reason.slice(separator + 1))}`);
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
export function selectRecommendations(candidates: Candidate[], count: number, rng: () => number, alreadySelected: RecommendationItem[] = []): RecommendationItem[] {
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
