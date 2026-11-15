import { BaseProvider } from './base.js';
import type { MediaType, SeriesMetadata, SearchResult } from './types.js';
import type { ProviderArtist, ArtistSearchPage, ArtistWorksPage } from '../contracts/artists.js';

const API_URL = 'https://graphql.anilist.co';

interface AniListMedia {
  id: number;
  title: { romaji?: string; english?: string; native?: string; userPreferred?: string };
  /** Alternate titles as entered by the community — may carry stray whitespace. */
  synonyms?: string[] | null;
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
interface AniListStaff {
  id: number;
  name: { full?: string; native?: string; alternative?: string[] };
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
    const result = await this.getPost<GqlEnvelope<TData>>('', { query, variables }, {
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
          title { romaji english native userPreferred }
          format
          coverImage { extraLarge large }
          description
          averageScore
          startDate { year month day }
          genres
          tags { name }
          studios { nodes { name } }
          status
          synonyms
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

    // Every known title (main fields + community synonyms) as plain strings —
    // the same convention as MangaDex's titleVariants: the identify dialog
    // offers each one for the ComicInfo.Series value, and apply validates
    // selectedTitle against this list. Synonyms may carry stray whitespace.
    const title = m.title.romaji || m.title.english || m.title.native || 'Unknown';
    const titleOptions = [...new Set(
      [m.title.romaji, m.title.english, m.title.native, m.title.userPreferred, ...(m.synonyms ?? [])]
        .filter((v): v is string => typeof v === 'string' && v.trim() !== '')
        .map((v) => v.trim()),
    )];
    if (!titleOptions.includes(title)) titleOptions.unshift(title);

    return {
      providerId: this.id,
      providerSeriesId: String(m.id),
      title,
      titleOptions,
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

  private artist(staff: AniListStaff): ProviderArtist {
    return { providerId: 'anilist', artistId: String(staff.id), name: staff.name.full || staff.name.native || `Staff #${staff.id}`,
      aliases: [...new Set([staff.name.native, ...(staff.name.alternative ?? [])].filter((value): value is string => !!value?.trim()))],
      url: `https://anilist.co/staff/${staff.id}` };
  }

  async searchArtists(search: string, page = 1): Promise<ArtistSearchPage> {
    const result = await this.gql<{ Page?: { staff: AniListStaff[]; pageInfo: { hasNextPage: boolean } } }>(
      `query ($search: String!, $page: Int!) {
        Page(page: $page, perPage: 25) {
          pageInfo { hasNextPage }
          staff(search: $search, sort: SEARCH_MATCH) { id name { full native alternative } }
        }
      }`, { search, page });
    if (!result.data?.Page) throw new Error('AniList did not return artist results');
    return { items: result.data.Page.staff.map(item => this.artist(item)), page, hasNextPage: result.data.Page.pageInfo.hasNextPage };
  }

  async getArtist(artistId: string): Promise<ProviderArtist> {
    const result = await this.gql<{ Staff?: AniListStaff }>(
      `query ($id: Int!) { Staff(id: $id) { id name { full native alternative } } }`, { id: Number(artistId) });
    if (!result.data?.Staff) throw new Error('AniList artist not found');
    return this.artist(result.data.Staff);
  }

  async getArtistWorks(artistId: string, page = 1): Promise<ArtistWorksPage> {
    const result = await this.gql<{ Staff?: { staffMedia: { nodes: AniListMedia[]; pageInfo: { hasNextPage: boolean } } } }>(
      `query ($id: Int!, $page: Int!) {
        Staff(id: $id) {
          staffMedia(type: MANGA, page: $page, perPage: 25, sort: [TITLE_ROMAJI, ID]) {
            pageInfo { hasNextPage }
            nodes { id title { romaji english native } synonyms format coverImage { extraLarge } startDate { year } description }
          }
        }
      }`, { id: Number(artistId), page });
    if (!result.data?.Staff) throw new Error('AniList artist not found');
    const works = result.data.Staff.staffMedia;
    // staffMedia includes every production role and has no title-search filter.
    // Keep the whole page; title similarity must not hide manual candidates.
    const items: SearchResult[] = [...new Map(works.nodes.map(media => [media.id, media])).values()].map(media => ({
      providerId: this.id, providerSeriesId: String(media.id),
      title: media.title.romaji || media.title.english || media.title.native || 'Unknown',
      altTitles: [...new Set([media.title.romaji, media.title.english, media.title.native, ...(media.synonyms ?? [])].filter((value): value is string => !!value?.trim()))],
      type: media.format === 'NOVEL' ? 'NOVEL' : 'MANGA', year: media.startDate?.year,
      coverUrl: media.coverImage?.extraLarge, summary: media.description?.replace(/<[^>]*>/g, '').trim(),
    }));
    return { items, page, hasNextPage: works.pageInfo.hasNextPage };
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
