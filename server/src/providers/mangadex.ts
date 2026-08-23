import { BaseProvider, toKavitaRating } from './base.js';
import type { MediaType, SeriesMetadata, SearchResult } from './types.js';

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
  providesFields = ['title', 'summary', 'genres', 'tags', 'publishers', 'releaseDate', 'status', 'cover'];
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

  /** Resolve a cover_art relationship id to an image URL via the /cover/{id} endpoint. */
  private async resolveCoverUrl(coverId: string | undefined, mangaId: string): Promise<string | undefined> {
    if (!coverId) return undefined;
    try {
      const res = await this.get<{ data?: { attributes?: { fileName?: string } } }>(
        `/cover/${coverId}`,
        { headers: this.headers() },
      );
      const fileName = res?.data?.attributes?.fileName;
      if (fileName) return `${this.imageBaseUrl}/covers/${mangaId}/${fileName}?volume=true`;
    } catch {
      /* fall through to no cover */
    }
    return undefined;
  }

  async search(query: string, type?: string): Promise<SearchResult[]> {
    const params = new URLSearchParams({
      title: query,
      limit: '20',
      'order[relevance]': 'desc',
    });
    const data = await this.get<{ data: any[] }>(`/manga?${params.toString()}`, {
      headers: this.headers(),
    });

    return (data.data ?? []).map((m) => {
      const a = m.attributes ?? {};
      const title = this.pickTitle(a);
      // Search collection items carry their own cover_art relationship id.
      const coverId = (m.relationships ?? []).find((r: any) => r.type === 'cover_art')?.id;
      return {
        providerId: this.id,
        providerSeriesId: m.id,
        title: typeof title === 'string' ? title : 'Unknown',
        type: 'MANGA' as SearchResult['type'],
        year: a.year ? Number(a.year) : undefined,
        coverUrl: coverId ? `${this.imageBaseUrl}/covers/${m.id}/${coverId}?volume=true` : undefined,
        summary: typeof a.description?.en === 'string' ? a.description.en.slice(0, 300) : undefined,
      } as SearchResult;
    });
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

    // In the detail response, relationships are inline objects of shape
    // { id, type, attributes?: { name?, fileName? } }.
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
    const coverUrl = await this.resolveCoverUrl(coverId, providerSeriesId);

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
    };
  }
}

export const mangaDexProvider: MangaDexProvider = new MangaDexProvider();
