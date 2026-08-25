import { BaseProvider } from './base.js';
import type { MediaType, SeriesMetadata, SearchResult } from './types.js';

const API_URL = 'https://graphql.anilist.co';

interface AniListMedia {
  id: number;
  title: { romaji?: string; english?: string; native?: string };
  format: string;
  coverImage: { extraLarge?: string; large?: string };
  description: string;
  averageScore: number;
  startDate: { year: number; month?: number; day?: number } | null;
  genres: string[];
  tags: { name: string; userId: number }[];
  // NOTE: AniList removed the `authors`/`artists` fields and `Studio.isMain`;
  // `studios` is now a connection exposing `nodes`.
  studios: { nodes: { name: string }[] } | null;
  status: string;
}
interface GqlEnvelope<TData> {
  data?: TData | null;
  errors?: { message?: string }[];
}


/**
 * AniList (GraphQL) — primary source for manga & light novel metadata:
 * summary, tags, release date.
 */
class AniListProvider extends BaseProvider {
  id = 'anilist';
  name = 'AniList';
  color = '#02b304';
  helpUrl = 'https://docs.anilist.co/guide/http/';
  supportedTypes: MediaType[] = ['MANGA', 'NOVEL'];
  requiresCredentials = false;
  providesFields = [
    'title', 'summary', 'genres', 'tags', 'writers', 'artists',
    'releaseDate', 'status', 'cover',
  ];
  protected baseUrl = API_URL;

  private async gql<TData>(query: string, variables: Record<string, unknown>): Promise<GqlEnvelope<TData>> {
    const result = await this.getPost<GqlEnvelope<TData>>('/graphql', { query, variables }, {
      'Content-Type': 'application/json',
    });
    // GraphQL can return validation/execution errors with HTTP 200 — surface them
    // instead of silently treating the response as an empty result.
    const err = result.errors?.[0]?.message;
    if (err) throw new Error(`AniList GraphQL error: ${String(err).slice(0, 240)}`);
    return result;
  }

  async testConnection(): Promise<void> {
    await this.gql<{ Media?: { id: number } | null }>('{ Media(id: 1) { id } }', {});
  }

  async search(query: string, type?: string): Promise<SearchResult[]> {
    const isNovel = type === 'NOVEL';
    const formatIn = isNovel ? 'NOVEL' : 'MANGA, NOVEL';
    const result = await this.gql<{ Page?: { media?: AniListMedia[] } | null }>(
      `query ($search: String) {
        Page(perPage: 20, page: 1) {
          media(format_in: [${formatIn}] search: $search sort: SEARCH_MATCH) {
            id
            title { romaji english native }
            format
            coverImage { extraLarge }
            averageScore
            startDate { year }
            description
          }
        }
      }`,
      { search: query },
    );
    const media: AniListMedia[] = result.data?.Page?.media ?? [];
    return media
      .filter((m) => (isNovel ? m.format === 'NOVEL' : true))
      .map((m) => ({
        providerId: this.id,
        providerSeriesId: String(m.id),
        title: m.title.romaji || m.title.english || m.title.native || 'Unknown',
        type: (m.format === 'NOVEL' ? 'NOVEL' : 'MANGA') as SearchResult['type'],
        year: m.startDate?.year,
        coverUrl: m.coverImage?.extraLarge,
        summary: m.description?.replace(/<[^>]*>/g, '').trim(),
      }));
  }

  async getSeriesMetadata(providerSeriesId: string): Promise<SeriesMetadata> {
    const result = await this.gql<{ Media?: AniListMedia | null }>(
      `query ($id: Int) {
        Media(id: $id) {
          id
          title { romaji english native }
          format
          coverImage { extraLarge large }
          description
          averageScore
          startDate { year month day }
          genres
          tags { name }
          studios { nodes { name } }
          status
        }
      }`,
      { id: Number(providerSeriesId) },
    );
    const m = result.data?.Media;
    if (!m) throw new Error(`AniList: media ${providerSeriesId} not found`);

    const date = m.startDate;
    const releaseDate = date
      ? `${date.year}-${String(date.month ?? 1).padStart(2, '0')}-${String(date.day ?? 1).padStart(2, '0')}`
      : undefined;

    return {
      providerId: this.id,
      providerSeriesId: String(m.id),
      title: m.title.romaji || m.title.english || m.title.native || 'Unknown',
      year: date?.year,
      releaseDate,
      summary: m.description?.replace(/<[^>]*>/g, '').trim(),
      coverUrl: m.coverImage?.extraLarge || m.coverImage?.large,
      genres: m.genres ?? [],
      tags: m.tags?.map((t) => t.name) ?? [],
      // AniList no longer exposes author/artist data for media, so these are empty.
      writers: [],
      artists: [],
      readingDirection: 'RTL',
      status: mapAniListStatus(m.status),
      url: `https://anilist.co/manga/${m.id}`,
    };
  }
}

function mapAniListStatus(status: string): SeriesMetadata['status'] {
  switch (status) {
    case 'RELEASING':
    case 'CURRENT':
      return 'ONGOING';
    case 'FINISHED':
    case 'ENDED':
      return 'COMPLETED';
    case 'HIATUS':
      return 'HIATUS';
    case 'CANCELED':
    case 'DROPPED':
      return 'CANCELLED';
    default:
      return 'UNKNOWN';
  }
}

export const anilistProvider: AniListProvider = new AniListProvider();