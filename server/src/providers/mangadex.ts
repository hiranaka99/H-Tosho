import { BaseProvider, toKavitaRating } from './base.js';
import type { MediaType, SeriesMetadata, SearchResult, VolumeCover } from './types.js';

/** Max concurrent /cover/{id} lookups while resolving search-result thumbnails. */
const COVER_RESOLVE_BATCH_SIZE = 6;

/**
 * Every contentRating value in MangaDex's current enum. The API's default
 * search scope hides pornographic-rated titles, so identify must request all
 * ratings explicitly or adult series are invisible to live title search.
 */
const CONTENT_RATINGS = ['safe', 'suggestive', 'erotica', 'pornographic'] as const;

/** Raw cover item as returned by the GET /cover collection (only consumed fields). */
interface CoverListItem {
  id: string;
  attributes?: {
    volume?: string | number | null;
    fileName?: string;
    locale?: string;
    updatedAt?: string;
  };
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
 * Extract tag lists that doujinshi uploaders embed in the description text
 * while leaving the structured `tags` array sparse. Three observed formats:
 * markdown table rows (`|MALE| glasses, harem`), bold labels
 * (`**FEMALE** ahegao, big breasts`), and plain `Tags:` lines. Only
 * line-anchored lines with a known namespace are parsed, so prose is never
 * treated as tags. Returns deduped (case-insensitive) tags in order of
 * appearance, capped at MAX_DESCRIPTION_TAGS.
 */
export function parseDescriptionTags(description: string | null | undefined): string[] {
  if (!description) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const addLine = (value: string): void => {
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
  };
  // Markdown table rows: |MALE| a, b — header/separator rows fail the namespace check.
  // [ \t]* (not \s*) keeps each match on its own line so a bare label can't swallow the next one.
  for (const m of description.matchAll(/^[ \t]*\|[ \t]*([A-Za-z]+)[ \t]*\|[ \t]*(.+?)[ \t]*$/gm)) {
    if (DESCRIPTION_TAG_NAMESPACES.has(m[1].toUpperCase())) addLine(m[2]);
  }
  // Bold labels: **MALE** a, b — a bare `**TAGS**` header has no value on its line and won't match.
  for (const m of description.matchAll(/^[ \t]*\*\*([A-Za-z]+)\*\*[ \t]*(.+?)[ \t]*$/gm)) {
    if (DESCRIPTION_TAG_NAMESPACES.has(m[1].toUpperCase())) addLine(m[2]);
  }
  // Plain line: Tags: a, b
  for (const m of description.matchAll(/^[ \t]*tags?[ \t]*:[ \t]*(.+?)[ \t]*$/gim)) {
    addLine(m[1]);
  }
  return out.slice(0, MAX_DESCRIPTION_TAGS);
}
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
  providesFields = ['title', 'summary', 'genres', 'tags', 'publishers', 'releaseDate', 'status', 'cover', 'volumeCovers'];
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
   * Fetch every published cover of a manga via the /cover collection and
   * reduce it to one entry per volume number. Locale preference is English,
   * then Japanese, then anything else; within a locale the most recently
   * updated upload wins (MangaDex re-uploads bump `updatedAt`).
   */
  private async fetchVolumeCovers(mangaId: string): Promise<VolumeCover[]> {
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
   */
  async preferredSeriesCoverUrl(mangaId: string): Promise<string | undefined> {
    try {
      const volumeCovers = await this.fetchVolumeCovers(mangaId);
      return volumeCovers.find((v) => v.number === 1)?.url;
    } catch {
      return undefined;
    }
  }

  async search(query: string, type?: string): Promise<SearchResult[]> {
    const params = new URLSearchParams({
      title: query,
      limit: '20',
      'order[relevance]': 'desc',
    });
    for (const rating of CONTENT_RATINGS) params.append('contentRating[]', rating);
    const data = await this.get<{ data?: MangaListItem[] }>(`/manga?${params.toString()}`, {
      headers: this.headers(),
    });

    // List items only carry cover_art relationship stubs ({id, type}), so each
    // candidate's cover must be resolved via /cover/{id} to get the fileName
    // the CDN actually serves. Resolve in small parallel batches; a failure
    // simply leaves that candidate without a thumbnail.
    const items = (data.data ?? []).map((m) => {
      const attrs = m.attributes ?? {};
      const title = this.pickTitle(attrs);
      return {
        mangaId: m.id,
        title,
        altTitles: this.titleVariants(attrs).filter((v) => v !== title),
        year: attrs.year ? Number(attrs.year) : undefined,
        summary: typeof attrs.description?.en === 'string' ? attrs.description.en.slice(0, 300) : undefined,
        coverId: (m.relationships ?? []).find((r) => r.type === 'cover_art')?.id,
        coverUrl: undefined as string | undefined,
      };
    });

    for (let i = 0; i < items.length; i += COVER_RESOLVE_BATCH_SIZE) {
      await Promise.all(
        items.slice(i, i + COVER_RESOLVE_BATCH_SIZE).map(async (item) => {
          item.coverUrl = await this.resolveCoverUrl(item.coverId, item.mangaId);
        }),
      );
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
    const data = await this.get<{ data: any }>(
      `/manga/${providerSeriesId}?${this.includesParam(['cover', 'author', 'artist'])}`,
      { headers: this.headers() },
    );
    const m = data.data;
    if (!m) throw new Error(`MangaDex: manga ${providerSeriesId} not found`);
    const a = m.attributes ?? {};
    const title = this.pickTitle(a);

    let releaseDate: string | undefined;
    const published = a.published as string | undefined;
    if (published) {
      const d = new Date(published);
      if (!Number.isNaN(d.getTime())) releaseDate = d.toISOString().slice(0, 10);
    }

    // Structured tags first, then tags extracted from the description text —
    // doujinshi uploaders often leave `tags` sparse and put the real list in
    // the summary. Existing spellings win on case-insensitive collisions so
    // structured tags keep their canonical form.
    const tags: string[] = (a.tags ?? []).map((t: any) => this.tagLabel(t)).filter(Boolean);
    const tagSeen = new Set(tags.map((t) => t.toLowerCase()));
    for (const parsed of parseDescriptionTags(typeof a.description?.en === 'string' ? a.description.en : undefined)) {
      if (!tagSeen.has(parsed.toLowerCase())) {
        tagSeen.add(parsed.toLowerCase());
        tags.push(parsed);
      }
    }

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
    // Per-volume covers come from the /cover collection; a failure here must
    // not sink the whole metadata fetch (series-level data is still usable).
    let volumeCovers: VolumeCover[] | undefined;
    try {
      volumeCovers = await this.fetchVolumeCovers(providerSeriesId);
    } catch {
      volumeCovers = undefined;
    }

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
      sortTitle: typeof a.title?.original === 'string' ? a.title.original : undefined,
      type: 'MANGA',
      year: a.year ? Number(a.year) : undefined,
      releaseDate,
      summary: typeof a.description?.en === 'string' ? a.description.en.trim() : undefined,
      coverUrl,
      genres: tags,
      tags,
      writers: people,
      artists: people,
      publishers: [],
      imprints: [],
      rating: undefined,
      readingDirection: a.originalLanguage === 'ja' ? 'RTL' : 'LTR',
      language: a.originalLanguage,
      status: status as SeriesMetadata['status'],
      url: `https://mangadex.org/title/${providerSeriesId}`,
      volumeCovers,
    };
  }
}

export const mangaDexProvider: MangaDexProvider = new MangaDexProvider();
