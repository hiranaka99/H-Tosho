import { BaseProvider } from './base.js';
import type { MediaType, SeriesMetadata, SearchResult } from './types.js';
import type { ProviderArtist, ArtistSearchPage, ArtistWorksPage } from '../contracts/artists.js';
import { anilistClient, ANILIST_API_URL } from './anilistClient.js';

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

/** Short-lived response cache bounds (per provider instance). */
const GQL_CACHE_TTL_MS = 10 * 60_000;
const GQL_CACHE_MAX = 256;


/**
 * AniList (GraphQL) — primary source for manga & light novel metadata:
 * summary, tags, release date.
 */
export class AniListProvider extends BaseProvider {
  constructor(private readonly client = anilistClient) { super(); }
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
  protected baseUrl = ANILIST_API_URL;

  /**
   * Successful responses for identical queries, kept briefly. AniList allows
   * one request per ~2.1 s through a single FIFO, so repeat lookups (reopening
   * an identify dialog, re-running a match, paging back) would otherwise wait
   * in line behind every queued request for data fetched moments ago. Errors
   * and rate-limited responses are never cached. Entries are read-only.
   */
  private readonly responseCache = new Map<string, { at: number; value: GqlEnvelope<unknown> }>();

  private async gql<TData>(query: string, variables: Record<string, unknown>, signal?: AbortSignal, cache = true): Promise<GqlEnvelope<TData>> {
    const key = JSON.stringify([query, variables]);
    const hit = cache ? this.responseCache.get(key) : undefined;
    if (hit && Date.now() - hit.at < GQL_CACHE_TTL_MS) {
      signal?.throwIfAborted();
      this.responseCache.delete(key);
      this.responseCache.set(key, hit);
      return hit.value as GqlEnvelope<TData>;
    }
    if (hit) this.responseCache.delete(key);
    const response = await this.client.post<GqlEnvelope<TData>>({ query, variables }, signal);
    if (response.status >= 400) throw new Error(this.describeError(response.status, response.data));
    const result = response.data;
    // GraphQL can return validation/execution errors with HTTP 200 — surface them
    // instead of silently treating the response as an empty result.
    const err = result.errors?.[0]?.message;
    if (err) throw new Error(`AniList GraphQL error: ${String(err).slice(0, 240)}`);
    while (this.responseCache.size >= GQL_CACHE_MAX) {
      const oldest = this.responseCache.keys().next();
      if (oldest.done) break;
      this.responseCache.delete(oldest.value);
    }
    this.responseCache.set(key, { at: Date.now(), value: result });
    return result;
  }

  async testConnection(): Promise<void> {
    // Always a live round-trip: a cached answer would not prove connectivity.
    await this.gql<{ Media?: { id: number } | null }>('{ Media(id: 1) { id } }', {}, undefined, false);
  }

  async search(query: string, type?: string, signal?: AbortSignal): Promise<SearchResult[]> {
    const isNovel = type === 'NOVEL';
    const formatIn = isNovel ? 'NOVEL' : 'MANGA, ONE_SHOT, NOVEL';
    const result = await this.gql<{ Page?: { media?: AniListMedia[] } | null }>(
      `query ($search: String) {
        Page(perPage: 20, page: 1) {
          media(format_in: [${formatIn}] search: $search sort: SEARCH_MATCH) {
            id
            title { romaji english native }
            synonyms
            format
            coverImage { extraLarge }
            averageScore
            startDate { year }
            description
          }
        }
      }`,
      { search: query }, signal,
    );
    const media: AniListMedia[] = result.data?.Page?.media ?? [];
    return media
      .filter((m) => (isNovel ? m.format === 'NOVEL' : true))
      .map((m) => ({
        providerId: this.id,
        providerSeriesId: String(m.id),
        title: m.title.romaji || m.title.english || m.title.native || 'Unknown',
        altTitles: [...new Set([m.title.romaji, m.title.english, m.title.native, ...(m.synonyms ?? [])]
          .filter((value): value is string => typeof value === 'string' && !!value.trim()).map(value => value.trim()))],
        type: (m.format === 'NOVEL' ? 'NOVEL' : 'MANGA') as SearchResult['type'],
        year: m.startDate?.year,
        coverUrl: m.coverImage?.extraLarge,
        summary: m.description?.replace(/<[^>]*>/g, '').trim(),
      }));
  }

  private mapMediaToSeriesMetadata(m: AniListMedia): SeriesMetadata {
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

  async getSeriesMetadata(providerSeriesId: string, signal?: AbortSignal): Promise<SeriesMetadata> {
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
      { id: Number(providerSeriesId) }, signal,
    );
    const m = result.data?.Media;
    if (!m) throw new Error(`AniList: media ${providerSeriesId} not found`);
    return this.mapMediaToSeriesMetadata(m);
  }

  async getSeriesMetadataBatch(providerSeriesIds: string[], signal?: AbortSignal): Promise<Map<string, SeriesMetadata>> {
    const out = new Map<string, SeriesMetadata>();
    const validIds = [...new Set(
      providerSeriesIds
        .map((id) => Number(id))
        .filter((id) => Number.isSafeInteger(id) && id > 0),
    )].sort((a, b) => a - b);
    for (let i = 0; i < validIds.length; i += 50) {
      signal?.throwIfAborted();
      const ids = validIds.slice(i, i + 50);
      const result = await this.gql<{ Page?: { media?: AniListMedia[] } | null }>(
        `query ($ids: [Int]) {
          Page(page: 1, perPage: 50) {
            media(id_in: $ids) {
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
          }
        }`,
        { ids },
        signal,
      );
      for (const m of result.data?.Page?.media ?? []) {
        out.set(String(m.id), this.mapMediaToSeriesMetadata(m));
      }
    }
    return out;
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
