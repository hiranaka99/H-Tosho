import { BaseProvider } from './base.js';
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
    'releaseDate', 'status', 'cover',
  ];
  protected baseUrl = 'https://api.myanimelist.net/v2';

  private headers(): Record<string, string> {
    const clientId = this.credentials?.['clientId'] ?? '';
    return { Authorization: clientId, 'X-MAL-CLIENT-ID': clientId, Accept: 'application/json' };
  }

  async testConnection(): Promise<void> {
    if (!this.credentials?.['clientId']) throw new Error('MyAnimeList: missing Client ID');
    // The /manga endpoint requires a `q` search term; use one to validate the key.
    const data = await this.get<{ data: any[] }>('/manga?q=test&limit=1', { headers: this.headers() });
    if (!Array.isArray(data?.data)) throw new Error('MyAnimeList: bad response (check Client ID)');
  }

  /** Cover URL from either the approved-client `images.jpg` shape or the stub `main_picture` shape. */
  private coverUrl(node: any): string | undefined {
    return (
      node?.images?.jpg?.large_image_url ??
      node?.images?.jpg?.image_url ??
      node?.main_picture?.large ??
      node?.main_picture?.medium
    );
  }

  async search(query: string, _type?: string): Promise<SearchResult[]> {
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
        // Approved clients expose `mal_id`; the public stub exposes `id`.
        providerSeriesId: String(a.mal_id ?? a.id),
        title: a.title ?? 'Unknown',
        type: typeMap[a.type] ?? 'MANGA',
        year: a.start_date ? new Date(a.start_date).getFullYear() : undefined,
        coverUrl: this.coverUrl(a),
        summary: a.synopsis ?? undefined,
      } as SearchResult;
    });
  }

  async getSeriesMetadata(providerSeriesId: string): Promise<SeriesMetadata> {
    // MAL omits most fields unless `fields=` is requested; ask for exactly
    // what the mapping below consumes so the payload stays small.
    const fields =
      'id,title,main_picture,alternative_titles,start_date,synopsis,genres,tags,authors{node{id,first_name,last_name},role},status,media_type';
    const data = await this.get<{ data: any }>(`/manga/${providerSeriesId}?fields=${encodeURIComponent(fields)}`, {
      headers: this.headers(),
    });
    // Approved clients wrap the node in `data`; the public stub returns it directly.
    const node = data?.data ?? data;
    if (!node || (node.id == null && node.mal_id == null)) {
      throw new Error(`MyAnimeList: manga ${providerSeriesId} not found`);
    }

    let releaseDate: string | undefined;
    if (node.start_date) {
      const d = new Date(node.start_date);
      if (!Number.isNaN(d.getTime())) releaseDate = d.toISOString().slice(0, 10);
    }

    // MAL authors are {node:{id,first_name,last_name},role} with role
    // 'Story' | 'Art' | 'Story & Art' — split them across the unified model
    // (the node itself has no `name`).
    const authors: { name: string; role?: string }[] = (
      node.authors ?? []
    ).map((p: { node?: { first_name?: string; last_name?: string }; role?: string }) => ({
      name: `${p?.node?.first_name ?? ''} ${p?.node?.last_name ?? ''}`.trim(),
      role: p?.role,
    }));

    return {
      providerId: this.id,
      providerSeriesId,
      title: node.title ?? 'Unknown',
      year: node.start_date ? new Date(node.start_date).getFullYear() : undefined,
      releaseDate,
      summary: node.synopsis?.trim(),
      coverUrl: this.coverUrl(node),
      genres: (node.genres ?? []).map((g: any) => g.name).filter(Boolean),
      tags: (node.tags ?? []).map((t: any) => t.name).filter(Boolean),
      writers: authors.filter((p) => p.role === 'Story' || p.role === 'Story & Art').map((p) => p.name).filter(Boolean),
      artists: authors.filter((p) => p.role === 'Art' || p.role === 'Story & Art').map((p) => p.name).filter(Boolean),
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
