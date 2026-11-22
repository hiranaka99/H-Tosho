import type { SearchScope } from './state';

/** One syntax hint for every search scope, tied to its input with aria-describedby. */
export function SearchHint({ id, scope }: { id: string; scope: SearchScope }) {
  return (
    <p id={id} className="break-words text-xs text-muted">
      {scope === 'all' ? 'Searches Hitomi.la, nHentai and E-Hentai together; repeated editions share one card. ' : 'Gallery IDs and URLs work here too. '}
      Filters: artist:, group:, parody:, character:, language: · “quoted phrases” · -exclusions.
    </p>
  );
}
