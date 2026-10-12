/** Namespace aliases used by the official nHentai search bar. */
export const NHENTAI_TAG_NAMESPACES: Record<string, string> = {
  tag: 'tag', tags: 'tag', artist: 'artist', artists: 'artist',
  parody: 'parody', parodies: 'parody', character: 'character', characters: 'character',
  group: 'group', groups: 'group', language: 'language', languages: 'language',
  category: 'category', categories: 'category',
};

/** Recognize fields without mistaking text inside a quoted phrase for a filter. */
function queryTerms(query: string): string[] {
  return query.match(/(?:[^\s"\\]|\\.|"(?:[^"\\]|\\.)*")+/g) ?? [];
}

export function nhentaiSearchQuery(query: string, banned = ''): string {
  const q = query.trim();
  const explicitLanguage = queryTerms(q).some(term => /^languages?:\S/i.test(term));
  return [q, explicitLanguage ? '' : 'language:english', banned].filter(Boolean).join(' ');
}

export function nhentaiAutocompleteQuery(query: string): { query: string; type?: string } | null {
  const term = query.trim().replace(/^[-–—]/, '');
  const field = /^([a-z_]+):(.*)$/is.exec(term);
  if (!field) return term ? { query: term.replace(/^"|"$/g, '') } : null;
  const type = NHENTAI_TAG_NAMESPACES[field[1].toLowerCase()];
  // Numeric, date and title filters are search operators, not tag lookups.
  if (!type) return null;
  return { type, query: field[2].replace(/^"|"$/g, '') };
}

export function nhentaiBannedTerm(value: string): string {
  const raw = value.trim().replace(/^-/g, '');
  const field = /^([a-z_]+):(.*)$/is.exec(raw);
  if (field && NHENTAI_TAG_NAMESPACES[field[1].toLowerCase()]) {
    const name = field[2].trim().replace(/"/g, '');
    return name ? `-${NHENTAI_TAG_NAMESPACES[field[1].toLowerCase()]}:"${name}"` : '';
  }
  const name = raw.replace(/"/g, '');
  return name ? `-"${name}"` : '';
}
