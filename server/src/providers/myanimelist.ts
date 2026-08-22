import { BaseProvider, toKavitaRating } from './base.js';
import type { MediaType, SeriesMetadata, SearchResult } from './types.js';

/**
 * MyAnimeList - REST API v2. Requires a Client ID (obtain at
 * https://myanimelist.net/devs). Auth uses `Authorization: <clientId>`.
 */
class MyAnimeListProvider extends BaseProvider {
  id = 'myanimelist';
  name = 'MyAnimeList';
  color = '#2e51a2';
  helpUrl = 'https://myanimelist.net/devs/api_client_id';
  supportedTypes: MediaType[] = ['MANGA', 'NOVEL', 'COMIC', 'WEBTOON'];
  requiresCredentials = true;
  providesFields = [
    'title', 'summary', 'genres', 'tags', 'writers', 'artists',
    'publishers', 'releaseDate', 'status', 'cover', 'rating',
  ];
  protected baseUrl = 'https://api.myanimelist.net/v2';

  private headers(): Record<string, string> {
    const clientId = this.credentials?.['clientId'] ?? '';
    return { Authorization: clientId, 'X-MAL-CLIENT-ID': clientId, Accept: 'application/json' };
  }

  async testConnection(): Promise<void> {
    if (!this.credentials?.['clientId']) throw new Error('MyAnimeList: missing Client ID');
    const data = await this.get<{ data: any[] }>('/manga?limit=1', { headers: this.headers() });
    if (!Array.isArray(data?.data)) throw new Error('MyAnimeList: bad response (check Client ID)');
  }

  async search(query: string, type?: string): Promise<SearchResult[]> {
    const params = new URLSearchParams({ q: query, limit: '20' });
    const data = await this.get<{ data: any[] }>(`/manga?${params.toString()}`, {
      headers: this.headers(),
    });
    return (data.data ?? []).map((m) => {
      const a = m.node ?? {};
      const typeMap: Record<string, SearchResult['type']> = {
        manga: 'MANGA',
        light_novel: 'NOVEL',
        novel: 'NOVEL',
        one_shot: 'MANGA',
        doujinshi: 'COMIC',
      };
      return {
        providerId: this.id,
        providerSeriesId: String(a.mal_id),
        title: a.title ?? 'Unknown',
        type: typeMap[a.type] ?? 'MANGA',
        year: a.start_date ? new Date(a.start_date).getFullYear() : undefined,
        coverUrl: a.images?.jpg?.large_image_url ?? a.images?.jpg?.image_url,
        summary: a.synopsis ?? undefined,
      } as SearchResult;
    });
  }

  async getSeriesMetadata(providerSeriesId: string): Promise<SeriesMetadata> {
    const data = await this.get<{ data: any }>(`/manga/${providerSeriesId}`, {
      headers: this.headers(),
    });
    const node = data.data;
    if (!node) throw new Error(`MyAnimeList: manga ${providerSeriesId} not found`);

    let releaseDate: string | undefined;
    if (node.start_date) {
      const d = new Date(node.start_date);
      if (!Number.isNaN(d.getTime())) releaseDate = d.toISOString().slice(0, 10);
    }

    const typeMap: Record<string, SeriesMetadata['type']> = {
      manga: 'MANGA',
      light_novel: 'NOVEL',
      novel: 'NOVEL',
      one_shot: 'MANGA',
      doujinshi: 'COMIC',
    };

    return {
      providerId: this.id,
      providerSeriesId,
      title: node.title ?? 'Unknown',
      sortTitle: node.title,
      type: typeMap[node.type] ?? 'MANGA',
      year: node.start_date ? new Date(node.start_date).getFullYear() : undefined,
      releaseDate,
      summary: node.synopsis?.trim(),
      coverUrl: node.images?.jpg?.large_image_url ?? node.images?.jpg?.image_url,
      genres: (node.genres ?? []).map((g: any) => g.name).filter(Boolean),
      tags: (node.tags ?? []).map((t: any) => t.name).filter(Boolean),
      writers: (node.authors ?? []).map((p: any) => p.name).filter(Boolean),
      artists: (node.authors ?? []).map((p: any) => p.name).filter(Boolean),
      publishers: (node.publishers ?? []).map((p: any) => p.name).filter(Boolean),
      imprints: [],
      rating: toKavitaRating(node.score),
      readingDirection: 'RTL',
      language: 'en',
      status: mapMalStatus(node.status),
      url: `https://myanimelist.net/manga/${providerSeriesId}`,
    };
  }
}

function mapMalStatus(status: string | undefined): SeriesMetadata['status'] {
  switch (status) {
    case 'ongoing':
      return 'ONGOING';
    case 'finished':
      return 'COMPLETED';
    case 'hiatus':
      return 'HIATUS';
    case 'discontinued':
      return 'CANCELLED';
    default:
      return 'UNKNOWN';
  }
}

export const myAnimeListProvider: MyAnimeListProvider = new MyAnimeListProvider();
