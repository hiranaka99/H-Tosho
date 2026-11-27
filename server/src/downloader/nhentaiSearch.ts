/** Namespace aliases used by the official nHentai search bar. */
export const NHENTAI_TAG_NAMESPACES: Record<string, string> = {
  tag: "tag",
  tags: "tag",
  artist: "artist",
  artists: "artist",
  parody: "parody",
  parodies: "parody",
  character: "character",
  characters: "character",
  group: "group",
  groups: "group",
  language: "language",
  languages: "language",
  category: "category",
  categories: "category",
};

/** Recognize fields without mistaking text inside a quoted phrase for a filter. */
function queryTerms(query: string): string[] {
  return query.match(/(?:[^\s"\\]|\\.|"(?:[^"\\]|\\.)*")+/g) ?? [];
}

/** Artist-only searches use the exact tag listing. Leave compound queries to
 * the search engine so their operators and exclusions keep their meaning. */
export function nhentaiArtistSearch(
  query: string
): { slug: string; language: string } | null {
  let artist: string | undefined;
  let language = "english";
  let languageSpecified = false;
  try {
    const url = new URL(query.trim());
    const match = /^\/artist\/([^/]+)\/?$/.exec(url.pathname);
    if (
      url.protocol === "https:" &&
      url.hostname === "nhentai.net" &&
      !url.port &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      match
    ) {
      return { slug: decodeURIComponent(match[1]), language };
    }
  } catch {
    /* ordinary query */
  }
  for (const term of queryTerms(query.trim())) {
    const field = /^(artists?|languages?):(.+)$/i.exec(term);
    if (!field) return null;
    let value = field[2];
    if (value.startsWith('"')) {
      try {
        const parsed: unknown = JSON.parse(value);
        if (typeof parsed !== "string") return null;
        value = parsed;
      } catch {
        return null;
      }
    }
    if (typeof value !== "string" || !value.trim() || /[*?]/.test(value))
      return null;
    if (/^artist/i.test(field[1])) {
      if (artist) return null;
      artist = value.trim();
    } else {
      if (languageSpecified) return null;
      languageSpecified = true;
      language = value.trim().toLowerCase();
    }
  }
  return artist
    ? { slug: artist.toLowerCase().replace(/\s+/g, "-"), language }
    : null;
}

export function nhentaiSearchQuery(query: string, banned = ""): string {
  const q = query.trim();
  const explicitLanguage = queryTerms(q).some((term) =>
    /^languages?:\S/i.test(term)
  );
  return [q, explicitLanguage ? "" : "language:english", banned]
    .filter(Boolean)
    .join(" ");
}

export function nhentaiAutocompleteQuery(
  query: string
): { query: string; type?: string } | null {
  const term = query.trim().replace(/^[-–—]/, "");
  const field = /^([a-z_]+):(.*)$/is.exec(term);
  if (!field) return term ? { query: term.replace(/^"|"$/g, "") } : null;
  const type = NHENTAI_TAG_NAMESPACES[field[1].toLowerCase()];
  // Numeric, date and title filters are search operators, not tag lookups.
  if (!type) return null;
  return { type, query: field[2].replace(/^"|"$/g, "") };
}

export function nhentaiBannedTerm(value: string): string {
  const raw = value.trim().replace(/^-/g, "");
  const field = /^([a-z_]+):(.*)$/is.exec(raw);
  if (field && NHENTAI_TAG_NAMESPACES[field[1].toLowerCase()]) {
    const name = field[2].trim().replace(/"/g, "");
    return name
      ? `-${NHENTAI_TAG_NAMESPACES[field[1].toLowerCase()]}:"${name}"`
      : "";
  }
  const name = raw.replace(/"/g, "");
  return name ? `-"${name}"` : "";
}
