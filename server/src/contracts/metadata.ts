/** Pure metadata rules shared by preview and application. No I/O dependencies. */
export const PUBLICATION_STATUS = { ONGOING: 0, HIATUS: 1, COMPLETED: 2, CANCELLED: 3, UNKNOWN: undefined } as const;
export const EXCLUDABLE_FIELDS = {
  title: 'name', summary: 'summary', genres: 'genres', tags: 'tags', writers: 'writers',
  artists: 'artists', releaseDate: 'releaseYear', language: 'language', status: 'publicationStatus', url: 'webLinks',
} as const;
export type SyncField = keyof typeof EXCLUDABLE_FIELDS;

export function releaseYear(meta: { year?: number; releaseDate?: string }): number | undefined {
  if (meta.year && meta.year >= 1 && meta.year <= 9999) return meta.year;
  const year = Number(meta.releaseDate?.slice(0, 4));
  return year >= 1 && year <= 9999 ? year : undefined;
}

export function mergeTagLists(existing: readonly string[], incoming: readonly string[]): string[] {
  const seen = new Set<string>();
  return [...existing, ...incoming].flatMap(raw => {
    const tag = raw.trim(), key = tag.toLowerCase();
    if (!tag || seen.has(key)) return [];
    seen.add(key);
    return [tag];
  });
}

export function selectMetadataFields<T extends object>(payload: T, excluded: readonly string[]): T {
  const selected = { ...payload };
  for (const field of excluded) {
    if (field in EXCLUDABLE_FIELDS) delete selected[EXCLUDABLE_FIELDS[field as SyncField] as keyof T];
  }
  return selected;
}
