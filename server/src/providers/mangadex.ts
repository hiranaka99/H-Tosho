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
    description?: { en?: string };
  };
  relationships?: Array<{ id?: string; type?: string }>;
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
      return {
        mangaId: m.id,
        title: this.pickTitle(attrs),
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

    const tags: string[] = (a.tags ?? []).map((t: any) => this.tagLabel(t)).filter(Boolean);

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
