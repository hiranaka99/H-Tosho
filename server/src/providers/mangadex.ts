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

  async testConnection(): Promise<void> {
    const data = await this.get<{ result: string }>('/manga?limit=1', { headers: this.headers() });
    if (data?.result !== 'ok') throw new Error('MangaDex: unexpected response');
  }

  async search(query: string, type?: string): Promise<SearchResult[]> {
    const params = new URLSearchParams({
      title: query,
      limit: '20',
      includes: 'cover',
      'order[relevance]': 'desc',
    });
    const data = await this.get<{ data: any[]; relationships?: any[] }>(
      `/manga?${params.toString()}`,
      { headers: this.headers() },
    );

    const coverMap = new Map<string, string>();
    for (const rel of data.relationships ?? []) {
      if (rel?.relationshipType === 'cover' && rel?.item?.attributes?.fileName) {
        coverMap.set(
          rel.item.id,
          `${this.imageBaseUrl}/covers/${rel.item.attributes.mangaId}/${rel.item.attributes.fileName}?volume=true`,
        );
      }
    }

    return (data.data ?? []).map((m) => {
      const a = m.attributes ?? {};
      const titles = a.title ?? {};
      const title =
        titles.english || titles.romaji || titles.original || 'Unknown';
      return {
        providerId: this.id,
        providerSeriesId: m.id,
        title: typeof title === 'string' ? title : 'Unknown',
        type: 'MANGA' as SearchResult['type'],
        year: a.year ? Number(a.year) : undefined,
        coverUrl: coverMap.get(m.id),
        summary: a.description?.value?.slice(0, 300),
      } as SearchResult;
    });
  }

  async getSeriesMetadata(providerSeriesId: string): Promise<SeriesMetadata> {
    const data = await this.get<{ data: any; relationships: any[] }>(
      `/manga/${providerSeriesId}?includes=cover,author,artist,translator,publisher`,
      { headers: this.headers() },
    );
    const m = data.data;
    if (!m) throw new Error(`MangaDex: manga ${providerSeriesId} not found`);
    const a = m.attributes ?? {};
    const titles = a.title ?? {};
    const title = titles.english || titles.romaji || titles.original || 'Unknown';

    let releaseDate: string | undefined;
    const published = a.published as string | undefined;
    if (published) {
      const d = new Date(published);
      if (!Number.isNaN(d.getTime())) releaseDate = d.toISOString().slice(0, 10);
    }

    const tags: string[] = (a.tags ?? [])
      .map((t: any) => t.attributes?.translation || t.attributes?.name || '')
      .filter(Boolean);

    let coverUrl: string | undefined;
    const people: string[] = [];
    const publishers: string[] = [];
    for (const rel of data.relationships ?? []) {
      const rt = rel.relationshipType;
      const item = rel.item;
      if (rt === 'cover' && item?.attributes?.fileName) {
        coverUrl = `${this.imageBaseUrl}/covers/${providerSeriesId}/${item.attributes.fileName}?volume=true`;
      } else if (rt === 'author' || rt === 'artist' || rt === 'translator') {
        if (item?.attributes?.name) people.push(item.attributes.name);
      } else if (rt === 'publisher') {
        if (item?.attributes?.name) publishers.push(item.attributes.name);
      }
    }

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
      sortTitle: typeof titles.romaji === 'string' ? titles.romaji : undefined,
      type: 'MANGA',
      year: a.year ? Number(a.year) : undefined,
      releaseDate,
      summary: a.description?.value?.trim(),
      coverUrl,
      genres: tags,
      tags,
      writers: people,
      artists: people,
      publishers,
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
