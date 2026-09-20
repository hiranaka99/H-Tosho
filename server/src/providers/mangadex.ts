import { BaseProvider } from './base.js';
import type { MediaType, SeriesMetadata, SearchResult, VolumeCover } from './types.js';

/**
 * Every contentRating value in MangaDex's current enum. The API's default
 * search scope hides pornographic-rated titles, so identify must request all
 * ratings explicitly or adult series are invisible to live title search.
 */
const CONTENT_RATINGS = ['safe', 'suggestive', 'erotica', 'pornographic'] as const;

/**
 * MangaDex title search can return no rows when an English publisher title
 * differs from the catalog translation and contains many glue words. A second
 * query with those words removed preserves distinctive terms while allowing
 * MangaDex's search index to bridge wording changes such as rejected/dumped.
 */
const TITLE_SEARCH_STOP_WORDS: Record<string, true> = {
  a: true, an: true, and: true, at: true, by: true, for: true, from: true,
  her: true, his: true, in: true, into: true, its: true, me: true, my: true,
  of: true, on: true, our: true, the: true, their: true, to: true, with: true, your: true,
};

function fallbackTitleQuery(query: string): string | null {
  const words = query.match(/[\p{L}\p{N}]+/gu) ?? [];
  const meaningful = words.filter((word) => word.length > 1 && !TITLE_SEARCH_STOP_WORDS[word.toLowerCase()]);
  const reduced = meaningful.join(' ');
  return meaningful.length >= 2 && reduced.toLowerCase() !== query.trim().toLowerCase() ? reduced : null;
}

/** Raw cover item as returned by the GET /cover collection (only consumed fields). */
interface CoverListItem {
  id: string;
  attributes?: {
    volume?: string | number | null;
    fileName?: string;
    locale?: string;
    updatedAt?: string;
  };
  relationships?: Array<{ id?: string; type?: string }>;
}

/** Raw manga list item as returned by GET /manga (only the fields search() consumes). */
interface MangaListItem {
  id: string;
  attributes?: {
    year?: number | string;
    title?: Record<string, unknown>;
    altTitles?: Array<Record<string, unknown>>;
    description?: { en?: string };
  };
  relationships?: Array<{ id?: string; type?: string }>;
}
/** Namespaces whose description lines carry tag lists (MangaDex's tag taxonomy). */
const DESCRIPTION_TAG_NAMESPACES = new Set(['MALE', 'FEMALE', 'MIXED', 'OTHER', 'PARODY', 'CHARACTER']);

/** Cap on tags extracted from one description so pathological lists stay bounded (real doujinshi lists run to ~40). */
const MAX_DESCRIPTION_TAGS = 60;

/**
 * The comma-separated value portion of a tag-list line, or null when the
 * line is not one. Three observed formats: markdown table rows
 * (`|MALE| glasses, harem`), bold labels (`**FEMALE** ahegao, big breasts`),
 * and plain `Tags:` lines. Namespace cells may carry uploader decoration —
 * leading dash bullets, bold markers, trailing colons (`|-**MALE**: | ...`)
 * — which is tolerated before the namespace check, so decorated rows parse
 * like their plain ones. Only lines with a known namespace parse as tags,
 * so prose is never treated as tags. [ \t]* (not \s*) keeps each match on
 * its own line so a bare label can't swallow the next one.
 */
function tagLineValue(line: string): string | null {
  let m = line.match(/^[ \t]*\|[ \t]*(?:-[ \t]*)?(?:\*\*)?([A-Za-z]+)(?:\*\*)?[ \t]*:?[ \t]*\|[ \t]*(.+?)[ \t]*$/);
  if (m) return DESCRIPTION_TAG_NAMESPACES.has(m[1].toUpperCase()) ? m[2] : null;
  m = line.match(/^[ \t]*\*\*([A-Za-z]+)\*\*[ \t]*:?[ \t]*(.+?)[ \t]*$/);
  if (m) return DESCRIPTION_TAG_NAMESPACES.has(m[1].toUpperCase()) ? m[2] : null;
  m = line.match(/^[ \t]*tags?[ \t]*:[ \t]*(.+?)[ \t]*$/i);
  return m ? m[1] : null;
}

/**
 * Extract tag lists that doujinshi uploaders embed in the description text
 * while leaving the structured `tags` array sparse. Returns deduped
 * (case-insensitive) tags in document order, capped at MAX_DESCRIPTION_TAGS.
 */
export function parseDescriptionTags(description: string | null | undefined): string[] {
  if (!description) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of description.split('\n')) {
    const value = tagLineValue(line);
    if (!value) continue;
    for (const raw of value.split(',')) {
      // Strip stray pipes (hybrid entries like `**MALE** | shotacon`) and the
      // sentence-final punctuation uploaders leave on a Tags: line's last item.
      const tag = raw.replace(/^\|+|\|+$/g, '').trim().replace(/[.,;]+$/, '');
      if (!tag) continue;
      const key = tag.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(tag);
    }
  }
  return out.slice(0, MAX_DESCRIPTION_TAGS);
}

/**
 * Remove the tag-list block(s) a description embeds, so the summary pushed
 * to Kavita is clean prose (the tags themselves land in the Tags field via
 * parseDescriptionTags). Drops whole contiguous table runs and bold-label
 * runs that contain at least one known-namespace line — including their
 * `| Namespace | Tags |` headers, separator rows, and bare `**TAGS**`
 * headers — plus standalone `Tags:` lines. Returns the cleaned text ('' when
 * the description consisted solely of tag blocks), or undefined when no tag
 * block was present (description stays untouched).
 */
export function stripDescriptionTagLines(description: string | null | undefined): string | undefined {
  if (!description) return undefined;
  const lines = description.split('\n');
  const drop = new Array<boolean>(lines.length).fill(false);
  const markRun = (isLine: (l: string) => boolean): void => {
    let i = 0;
    while (i < lines.length) {
      if (!isLine(lines[i])) {
        i++;
        continue;
      }
      let j = i;
      while (j < lines.length && isLine(lines[j])) j++;
      if (lines.slice(i, j).some((l) => tagLineValue(l) !== null)) {
        for (let k = i; k < j; k++) drop[k] = true;
      }
      i = j;
    }
  };
  markRun((l) => /^[ \t]*\|/.test(l)); // markdown table runs
  markRun((l) => /^[ \t]*\*\*[A-Za-z]+\*\*/.test(l)); // bold-label runs
  for (let k = 0; k < lines.length; k++) {
    if (/^[ \t]*tags?[ \t]*:[ \t]*\S/i.test(lines[k])) drop[k] = true;
  }
  if (!drop.some(Boolean)) return undefined;
  const cleaned = lines.filter((_, i) => !drop[i]).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return cleaned;
}
/**
 * Volume-1 cover URLs per manga id. Cover fileNames are immutable, so a
 * short-TTL cache avoids re-paging /cover for every candidate of every
 * identify request. Successful resolutions only — failures re-resolve next
 * time so a transient API hiccup is not remembered.
 */
const preferredCoverCache = new Map<string, { url: string; at: number }>();
const PREFERRED_COVER_CACHE_TTL_MS = 10 * 60_000;
const PREFERRED_COVER_CACHE_MAX = 500;

/**
 * MangaDex — REST API v5. Excellent cover art + detailed metadata.
 * No credentials required (Client-Agent header recommended).
 */
class MangaDexProvider extends BaseProvider {
  id = 'mangadex';
  name = 'MangaDex';
  color = '#0066ff';
  helpUrl = 'https://api.mangadex.org/docs';
  supportedTypes: MediaType[] = ['MANGA', 'WEBTOON'];
  requiresCredentials = false;
  providesFields = ['title', 'summary', 'genres', 'tags', 'releaseDate', 'status', 'cover', 'volumeCovers'];
  protected baseUrl = 'https://api.mangadex.org';
  private imageBaseUrl = 'https://uploads.mangadex.org';

  private headers(): Record<string, string> {
    return { 'Client-Agent': 'H-Tosho/1.0 (+https://github.com/h-tosho)' };
  }

  /** Build an `includes[]=` query fragment from a list of relationship types. */
  private includesParam(types: string[]): string {
    return types.map((t) => `includes%5B%5D=${encodeURIComponent(t)}`).join('&');
  }

  /** Pick the best human title. English may live on the main `title` object or in `altTitles`. */
  private pickTitle(a: any): string {
    const t = a?.title ?? {};
    const alt: any[] = Array.isArray(a?.altTitles) ? a.altTitles : [];
    const en = t.en || t.english || alt.find((x) => x?.en)?.en;
    return en || t.original || t['ja-ro'] || t.romaji || alt[0]?.original || 'Unknown';
  }

  /**
   * Every known title of a manga (main + alternates, all languages) as plain
   * strings — the matcher scores the series name against each so a folder
   * named after a romanized or alternate title still matches. The display
   * title from pickTitle is only one of these.
   */
  private titleVariants(a: any): string[] {
    const t = a?.title ?? {};
    const alts: any[] = Array.isArray(a?.altTitles) ? a.altTitles : [];
    const out: string[] = [];
    const push = (v: unknown) => {
      if (typeof v === 'string' && v.trim()) out.push(v.trim());
    };
    push(t.en);
    push(t.english);
    push(t.original);
    push(t['ja-ro']);
    push(t.romaji);
    for (const alt of alts) {
      push(alt?.en);
      push(alt?.original);
      push(alt?.['ja-ro']);
      push(alt?.ja);
    }
    return [...new Set(out)];
  }

  /** MangaDex tag labels may be a plain string or a localized object ({en, ja, ...}). */
  private tagLabel(t: any): string {
    const n = t?.attributes?.name;
    if (typeof n === 'string') return n;
    if (n && typeof n === 'object') {
      return n.en || Object.values(n).find((v) => typeof v === 'string' && v.trim()) || '';
    }
    return '';
  }

  async testConnection(): Promise<void> {
    const data = await this.get<{ result: string }>('/manga?limit=1', { headers: this.headers() });
    if (data?.result !== 'ok') throw new Error('MangaDex: unexpected response');
  }

  /**
   * Resolve a cover_art relationship id to an image URL. The CDN path needs
   * the cover's fileName (served by /cover/{id}), not the relationship id —
   * using the id as the file name 404s on uploads.mangadex.org.
   */
  private async resolveCoverUrl(coverId: string | undefined, mangaId: string): Promise<string | undefined> {
    if (!coverId) return undefined;
    try {
      const res = await this.get<{ data?: { attributes?: { fileName?: string } } }>(
        `/cover/${coverId}`,
        { headers: this.headers() },
      );
      const fileName = res?.data?.attributes?.fileName;
      if (fileName) return `${this.imageBaseUrl}/covers/${mangaId}/${fileName}`;
    } catch {
      /* fall through to no cover */
    }
    return undefined;
  }

  /**
   * Resolve many candidates' cover fileNames in bulk via the /cover
   * collection — one request per 100 manga instead of one GET /cover/{id}
   * per search result. Builds a mangaId -> fileName map from each row's
   * `manga` relationship; when a manga's known cover_art id (its main cover)
   * appears among the rows, that row wins so thumbnails resolve to the same
   * cover the per-id lookup used to pick. A failed chunk leaves those
   * candidates unresolved (no thumbnail) instead of failing the search.
   */
  private async bulkCoverFileNames(
    entries: ReadonlyArray<{ mangaId: string; coverId?: string }>,
  ): Promise<Map<string, string>> {
    const byManga = new Map<string, string>();
    for (let i = 0; i < entries.length; i += 100) {
      const chunk = entries.slice(i, i + 100);
      const query = chunk.map((entry) => `manga%5B%5D=${encodeURIComponent(entry.mangaId)}`).join('&');
      try {
        const res = await this.get<{ data?: CoverListItem[] }>(`/cover?${query}&limit=100`, {
          headers: this.headers(),
        });
        const preferred = new Set(chunk.map((entry) => entry.coverId).filter((id): id is string => Boolean(id)));
        for (const item of res?.data ?? []) {
          const fileName = item.attributes?.fileName;
          const mangaId = (item.relationships ?? []).find((rel) => rel.type === 'manga')?.id;
          if (!fileName || !mangaId) continue;
          if (preferred.has(item.id) || !byManga.has(mangaId)) byManga.set(mangaId, fileName);
        }
      } catch {
        /* candidates in this chunk keep no thumbnail */
      }
    }
    return byManga;
  }

  /**
   * Fetch every published cover of a manga via the /cover collection and
   * reduce it to one entry per volume number. Locale preference is English,
   * then Japanese, then anything else; within a locale the most recently
   * updated upload wins (MangaDex re-uploads bump `updatedAt`).
   */
  private async fetchVolumeCovers(mangaId: string, opts?: { stopAtVolume1?: boolean }): Promise<VolumeCover[]> {
    const byVolume = new Map<number, { rank: number; updatedAt: string; fileName: string }>();
    // Page through the collection (100/page); cap at 5 pages so a runaway
    // catalogue can't stall metadata fetches.
    for (let offset = 0; offset < 500; offset += 100) {
      const res = await this.get<{ response?: string; data?: CoverListItem[] }>(
        `/cover?manga%5B%5D=${mangaId}&limit=100&offset=${offset}&order%5Bvolume%5D=asc`,
        { headers: this.headers() },
      );
      const items = res?.data ?? [];
      for (const item of items) {
        const attrs = item.attributes;
        if (!attrs?.fileName) continue;
        const num = Number(attrs.volume);
        if (!Number.isFinite(num) || num <= 0) continue; // main/series-level covers have no volume
        const locale = (attrs.locale ?? '').toLowerCase();
        const rank = locale === 'en' ? 0 : locale === 'ja' ? 1 : 2;
        const updatedAt = attrs.updatedAt ?? '';
        const prev = byVolume.get(num);
        if (!prev || rank < prev.rank || (rank === prev.rank && updatedAt > prev.updatedAt)) {
          byVolume.set(num, { rank, updatedAt, fileName: attrs.fileName });
        }
      }
      if (res?.response !== 'collection' || items.length < 100) break;
      // Volumes arrive in ascending order, so once Volume 1 has been seen the
      // remaining pages can only add higher volumes — stop paging early.
      if (opts?.stopAtVolume1 && byVolume.has(1)) break;
    }
    return [...byVolume.entries()]
      .sort((x, y) => x[0] - y[0])
      .map(([number, entry]) => ({ number, url: `${this.imageBaseUrl}/covers/${mangaId}/${entry.fileName}` }));
  }

  /**
   * The Volume 1 cover when one exists — the image Apply & Sync pushes as the
   * series cover (see getSeriesMetadata). Search thumbnails resolve only the
   * main cover_art, so the identify dialog uses this to preview exactly what
   * will land in Kavita. Returns undefined when there is no Volume 1 cover or
   * the collection lookup fails; callers then keep their main-cover fallback.
   * Successful results are cached briefly (cover fileNames are immutable).
   */
  async preferredSeriesCoverUrl(mangaId: string): Promise<string | undefined> {
    const cached = preferredCoverCache.get(mangaId);
    const now = Date.now();
    if (cached) {
      if (now - cached.at < PREFERRED_COVER_CACHE_TTL_MS) return cached.url;
      preferredCoverCache.delete(mangaId);
    }
    try {
      const volumeCovers = await this.fetchVolumeCovers(mangaId, { stopAtVolume1: true });
      const url = volumeCovers.find((v) => v.number === 1)?.url;
      if (url) {
        if (preferredCoverCache.size >= PREFERRED_COVER_CACHE_MAX) {
          // Map iterates in insertion order, so the first key is the oldest entry.
          const oldest = preferredCoverCache.keys().next().value;
          if (oldest !== undefined) preferredCoverCache.delete(oldest);
        }
        preferredCoverCache.set(mangaId, { url, at: now });
      }
      return url;
    } catch {
      return undefined;
    }
  }

  async search(query: string, type?: string): Promise<SearchResult[]> {
    const search = async (title: string): Promise<MangaListItem[]> => {
      const params = new URLSearchParams({
        title,
        limit: '20',
        'order[relevance]': 'desc',
      });
      for (const rating of CONTENT_RATINGS) params.append('contentRating[]', rating);
      const data = await this.get<{ data?: MangaListItem[] }>(`/manga?${params.toString()}`, {
        headers: this.headers(),
      });
      return data.data ?? [];
    };

    let found = await search(query);
    const fallback = found.length === 0 ? fallbackTitleQuery(query) : null;
    if (fallback) found = await search(fallback);

    // List items only carry cover_art relationship stubs ({id, type}), so the
    // fileNames the CDN actually serves must be resolved through the /cover
    // collection — in bulk (one request per 100 manga) instead of one GET per
    // candidate. A candidate whose cover cannot be resolved keeps no thumbnail.
    const items = found.map((m) => {
      const attrs = m.attributes ?? {};
      const title = this.pickTitle(attrs);
      return {
        mangaId: m.id,
        title,
        altTitles: this.titleVariants(attrs).filter((v) => v !== title),
        year: attrs.year ? Number(attrs.year) : undefined,
        summary: typeof attrs.description?.en === 'string' ? attrs.description.en : undefined,
        coverId: (m.relationships ?? []).find((r) => r.type === 'cover_art')?.id,
        coverUrl: undefined as string | undefined,
      };
    });

    const coverFileNames = await this.bulkCoverFileNames(
      items.map((item) => ({ mangaId: item.mangaId, coverId: item.coverId })),
    );
    for (const item of items) {
      const fileName = coverFileNames.get(item.mangaId);
      if (fileName) item.coverUrl = `${this.imageBaseUrl}/covers/${item.mangaId}/${fileName}`;
    }

    return items.map((item) => ({
      providerId: this.id,
      providerSeriesId: item.mangaId,
      title: typeof item.title === 'string' ? item.title : 'Unknown',
      altTitles: item.altTitles.length ? item.altTitles : undefined,
      type: 'MANGA' as SearchResult['type'],
      year: item.year,
      coverUrl: item.coverUrl,
      summary: item.summary,
    }) as SearchResult);
  }

  async getSeriesMetadata(providerSeriesId: string): Promise<SeriesMetadata> {
    // Per-volume covers only need the series id and are independent of the
    // detail fetch — start both together; a cover-collection failure must not
    // sink the whole metadata fetch (series-level data is still usable).
    const volumeCoversPromise = this.fetchVolumeCovers(providerSeriesId).catch(() => undefined);
    const data = await this.get<{ data: any }>(
      `/manga/${providerSeriesId}?${this.includesParam(['cover', 'author', 'artist'])}`,
      { headers: this.headers() },
    );
    const m = data.data;
    if (!m) throw new Error(`MangaDex: manga ${providerSeriesId} not found`);
    const a = m.attributes ?? {};
    const title = this.pickTitle(a);
    // The matcher scores every known variant (autoMatch.bestVariant), so the
    // ComicInfo.Series choices must cover the same set — otherwise a candidate
    // whose best-matching name is an alternate title fails apply validation.
    const titleOptions = [...new Set(this.titleVariants(a))];
    if (!titleOptions.includes(title)) titleOptions.unshift(title);

    let releaseDate: string | undefined;
    const published = a.published as string | undefined;
    if (published) {
      const d = new Date(published);
      if (!Number.isNaN(d.getTime())) releaseDate = d.toISOString().slice(0, 10);
    }

    // Doujinshi uploaders often leave `tags` sparse and put the real list in
    // the description text. Extract it once: parsed tags are appended after
    // the structured ones (existing spellings win on case-insensitive
    // collisions), and the tag block itself is stripped from the summary so
    // Kavita receives clean prose. Only tags MangaDex classifies as `genre`
    // feed the genres field — themes, format tags, and description-extracted
    // tags land in tags only, mirroring the page's Genres/Themes/Format split.
    const rawDescription = typeof a.description?.en === 'string' ? a.description.en : undefined;
    const tags: string[] = [];
    const genres: string[] = [];
    const tagSeen = new Set<string>();
    const genreSeen = new Set<string>();
    for (const t of a.tags ?? []) {
      const label = this.tagLabel(t);
      if (!label) continue;
      const key = label.toLowerCase();
      if (!tagSeen.has(key)) {
        tagSeen.add(key);
        tags.push(label);
      }
      if (t?.attributes?.group === 'genre' && !genreSeen.has(key)) {
        genreSeen.add(key);
        genres.push(label);
      }
    }
    for (const parsed of parseDescriptionTags(rawDescription)) {
      const key = parsed.toLowerCase();
      if (!tagSeen.has(key)) {
        tagSeen.add(key);
        tags.push(parsed);
      }
    }
    // undefined = no tag block present (raw description stands); '' = the
    // description was tag blocks only — an empty summary is pushed so stale
    // tag tables already in Kavita get cleared instead of surviving forever.
    const cleanedDescription = stripDescriptionTagLines(rawDescription);
    const summaryText = (cleanedDescription ?? rawDescription)?.trim() || (rawDescription ? '' : undefined);

    // In the detail response, author/artist relationships are inlined with
    // attributes ({ id, type, attributes: { name } }); cover_art stays a stub,
    // so its fileName is resolved separately via /cover/{id}.
    const people: string[] = [];
    let coverId: string | undefined;
    for (const rel of m.relationships ?? []) {
      const rt = rel.type;
      if (rt === 'cover_art') {
        coverId = rel.id ?? coverId;
      } else if (rt === 'author' || rt === 'artist') {
        const name = rel.attributes?.name;
        if (name && !people.includes(name)) people.push(name);
      }
    }
    const volumeCovers = await volumeCoversPromise;

    // The series cover is always the Volume 1 cover when one exists; otherwise
    // fall back to the manga's main cover_art (which also skips the extra
    // /cover/{id} lookup, since the collection already yielded the fileName).
    const vol1Cover = volumeCovers?.find((v) => v.number === 1);
    const coverUrl = vol1Cover?.url ?? (await this.resolveCoverUrl(coverId, providerSeriesId));

    const statusUpper = (a.status ?? '').toUpperCase();
    const status =
      statusUpper === 'ONGOING' ? 'ONGOING'
      : statusUpper === 'COMPLETED' ? 'COMPLETED'
      : statusUpper === 'HIATUS' ? 'HIATUS'
      : statusUpper === 'CANCELLED' ? 'CANCELLED'
      : 'UNKNOWN';

    return {
      providerId: this.id,
      providerSeriesId,
      title: typeof title === 'string' ? title : 'Unknown',
      titleOptions,
      year: a.year ? Number(a.year) : undefined,
      releaseDate,
      summary: summaryText,
      coverUrl,
      genres,
      tags,
      writers: people,
      artists: people,
      readingDirection: a.originalLanguage === 'ja' ? 'RTL' : 'LTR',
      language: a.originalLanguage,
      status: status as SeriesMetadata['status'],
      url: `https://mangadex.org/title/${providerSeriesId}`,
      volumeCovers,
    };
  }
}

export const mangaDexProvider: MangaDexProvider = new MangaDexProvider();
