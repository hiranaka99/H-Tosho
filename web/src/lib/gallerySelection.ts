import type { DoujinSearchResult } from "./api";

/** Search metadata takes precedence over the smaller watched-feed records. */
export function indexSelectableGalleries(
  results: readonly DoujinSearchResult[],
  feed: readonly DoujinSearchResult[]
) {
  const byKey = new Map<string, DoujinSearchResult>();
  for (const item of results)
    byKey.set(`${item.source}:${item.galleryId}`, item);
  for (const item of feed) {
    const key = `${item.source}:${item.galleryId}`;
    if (!byKey.has(key)) byKey.set(key, item);
  }
  return byKey;
}

export function selectedGalleryItems(
  index: ReadonlyMap<string, DoujinSearchResult>,
  selected: ReadonlySet<string>
): DoujinSearchResult[] {
  return [...selected]
    .map((key) => index.get(key))
    .filter((item): item is DoujinSearchResult => !!item);
}
