import type { DoujinSearchResult, DuplicateReport } from '../../lib/api';

/** What the app knows about a gallery relative to the user's library. */
export type GalleryOwnership = {
  type: 'available' | 'downloaded' | 'in-library' | 'possible-duplicate' | 'better-edition';
  downloadedAt?: string | null;
  preferenceOwned?: boolean;
};
export type LibraryMatch = 'owned' | 'possible' | 'better' | undefined;

/**
 * One library verdict per checked gallery. A confirmed copy is owned; a match
 * that is not an earlier edition makes it a possible duplicate; only when every
 * match is an earlier (censored/unmarked) edition is it a better edition.
 */
export function libraryMatchFor(report: Pick<DuplicateReport, 'matches'>): LibraryMatch {
  if (report.matches.some(match => match.confirmed && ['In library', 'Owned', 'completed'].includes(match.status))) return 'owned';
  if (!report.matches.length) return undefined;
  return report.matches.every(match => match.betterEdition) ? 'better' : 'possible';
}

export const galleryKey = (item: Pick<DoujinSearchResult, 'source' | 'galleryId'>) => `${item.source}:${item.galleryId}`;

/**
 * One ownership verdict for one or more keys (unified entries pass every
 * variant). Kavita matches outrank local downloads, which outrank fuzzy matches.
 */
export function galleryOwnership(
  keys: readonly string[],
  libraryMatches: ReadonlyMap<string, LibraryMatch>,
  downloadedAt: ReadonlyMap<string, string | null>,
  ownedKeys: ReadonlySet<string>,
): GalleryOwnership {
  const anyInLibrary = keys.some(key => libraryMatches.get(key) === 'owned');
  const anyDownloaded = keys.some(key => downloadedAt.has(key) || ownedKeys.has(key));
  const anyPossible = keys.some(key => libraryMatches.get(key) === 'possible');
  const anyBetter = keys.some(key => libraryMatches.get(key) === 'better');
  return {
    type: anyInLibrary ? 'in-library' : anyDownloaded ? 'downloaded' : anyPossible ? 'possible-duplicate' : anyBetter ? 'better-edition' : 'available',
    downloadedAt: downloadedAt.get(keys[0] ?? '') ?? null,
    preferenceOwned: keys.some(key => ownedKeys.has(key)),
  };
}

/** Plain-language meaning of each non-default state, shown as a tooltip and in the legend. */
export const OWNERSHIP_LABELS: Record<Exclude<GalleryOwnership['type'], 'available'>, { label: string; help: string }> = {
  'in-library': { label: 'In library', help: 'A matching series already exists in your Kavita library.' },
  downloaded: { label: 'Downloaded', help: 'H-Tosho has already downloaded this gallery.' },
  'possible-duplicate': { label: 'Possible duplicate', help: 'A similar title or artist is already in your library. Review before downloading.' },
  'better-edition': { label: 'Better edition', help: 'An uncensored or decensored edition of a gallery you already own. Your copy is censored or not marked uncensored.' },
};
