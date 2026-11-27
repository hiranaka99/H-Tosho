import { BaseProvider } from "./base.js";
import type { MediaType, SeriesMetadata, SearchResult } from "./types.js";
import {
  searchMalArtists,
  getMalArtist,
  getMalArtistWorks,
} from "./malArtistPages.js";

// MAL rejects search keywords outside 3–64 characters with HTTP 400 "invalid q".
// Count Unicode code points so truncation never splits a surrogate pair.
const MIN_SEARCH_LENGTH = 3;
const MAX_SEARCH_LENGTH = 64;

/**
 * MyAnimeList - REST API v2. Requires a Client ID (obtain at
 * https://myanimelist.net/devs). Auth uses `X-MAL-CLIENT-ID`.
 */
interface MalImageSet {
  large_image_url?: string;
  image_url?: string;
}

interface MalNode {
  id?: number | string;
  mal_id?: number | string;
  title?: string;
  alternative_titles?: { en?: string; ja?: string; synonyms?: string[] };
  media_type?: string;
  type?: string;
  start_date?: string;
  synopsis?: string;
  images?: { jpg?: MalImageSet };
  main_picture?: { large?: string; medium?: string };
  genres?: { name?: string }[];
  tags?: { name?: string }[];
  authors?: {
    node?: { first_name?: string; last_name?: string };
    role?: string;
  }[];
  status?: string;
}

interface MalSearchEntry {
  node?: MalNode;
}

class MyAnimeListProvider extends BaseProvider {
  id = "myanimelist";
  name = "MyAnimeList";
  color = "#2e51a2";
  helpUrl = "https://myanimelist.net/devs/api_client_id";
  supportedTypes: MediaType[] = ["MANGA", "NOVEL", "COMIC", "WEBTOON"];
  requiresCredentials = true;
  providesFields = [
    "title",
    "summary",
    "genres",
    "tags",
    "writers",
    "artists",
    "releaseDate",
    "status",
    "cover",
  ];
  protected baseUrl = "https://api.myanimelist.net/v2";
  searchArtists = searchMalArtists;
  getArtist = getMalArtist;
  getArtistWorks = getMalArtistWorks;

  private headers(): Record<string, string> {
    const clientId = this.credentials?.["clientId"] ?? "";
    return { "X-MAL-CLIENT-ID": clientId, Accept: "application/json" };
  }

  async testConnection(): Promise<void> {
    if (!this.credentials?.["clientId"])
      throw new Error("MyAnimeList: missing Client ID");
    // The /manga endpoint requires a `q` search term; use one to validate the key.
    const data = await this.get<{ data?: MalSearchEntry[] }>(
      "/manga?q=test&limit=1",
      { headers: this.headers() }
    );
    if (!Array.isArray(data?.data))
      throw new Error("MyAnimeList: bad response (check Client ID)");
  }

  /** Cover URL from either the approved-client `images.jpg` shape or the stub `main_picture` shape. */
  private coverUrl(node: MalNode | undefined): string | undefined {
    return (
      node?.images?.jpg?.large_image_url ??
      node?.images?.jpg?.image_url ??
      node?.main_picture?.large ??
      node?.main_picture?.medium
    );
  }

  async search(
    query: string,
    _type?: string,
    signal?: AbortSignal
  ): Promise<SearchResult[]> {
    const characters = Array.from(query.replace(/\s+/gu, " ").trim());
    if (characters.length < MIN_SEARCH_LENGTH) return [];
    const keyword = characters.slice(0, MAX_SEARCH_LENGTH).join("").trimEnd();
    const params = new URLSearchParams({
      q: keyword,
      limit: "20",
      nsfw: "true",
      fields: "alternative_titles,media_type,start_date,synopsis",
    });
    const data = await this.get<{ data?: MalSearchEntry[] }>(
      `/manga?${params.toString()}`,
      {
        headers: this.headers(),
        ...(signal ? { signal } : {}),
      }
    );
    return (data.data ?? []).map((m) => {
      const a = m.node ?? {};
      const typeMap: Record<string, SearchResult["type"]> = {
        manga: "MANGA",
        light_novel: "NOVEL",
        novel: "NOVEL",
        one_shot: "MANGA",
        doujinshi: "COMIC",
      };
      const rawType = a.media_type ?? a.type;
      return {
        providerId: this.id,
        // Approved clients expose `mal_id`; the public stub exposes `id`.
        providerSeriesId: String(a.mal_id ?? a.id ?? ""),
        title: a.title ?? "Unknown",
        altTitles: [
          ...new Set<string>(
            [
              a.alternative_titles?.en,
              a.alternative_titles?.ja,
              ...(a.alternative_titles?.synonyms ?? []),
            ].filter(
              (title): title is string =>
                typeof title === "string" && !!title.trim()
            )
          ),
        ],
        type: (rawType ? typeMap[rawType] : undefined) ?? "MANGA",
        year: a.start_date ? new Date(a.start_date).getFullYear() : undefined,
        coverUrl: this.coverUrl(a),
        summary: a.synopsis ?? undefined,
      };
    });
  }

  async getSeriesMetadata(
    providerSeriesId: string,
    signal?: AbortSignal
  ): Promise<SeriesMetadata> {
    // MAL omits most fields unless `fields=` is requested; ask for exactly
    // what the mapping below consumes so the payload stays small.
    const fields =
      "id,title,main_picture,alternative_titles,start_date,synopsis,genres,authors{first_name,last_name},status,media_type";
    const data = await this.get<{ data?: MalNode } & MalNode>(
      `/manga/${providerSeriesId}?fields=${encodeURIComponent(fields)}`,
      {
        headers: this.headers(),
        ...(signal ? { signal } : {}),
      }
    );
    // Approved clients wrap the node in `data`; the public stub returns it directly.
    const node = data?.data ?? data;
    if (!node || (node.id == null && node.mal_id == null)) {
      throw new Error(`MyAnimeList: manga ${providerSeriesId} not found`);
    }

    let releaseDate: string | undefined;
    if (node.start_date) {
      const d = new Date(node.start_date);
      if (!Number.isNaN(d.getTime()))
        releaseDate = d.toISOString().slice(0, 10);
    }

    // MAL authors are {node:{id,first_name,last_name},role} with role
    // 'Story' | 'Art' | 'Story & Art' — split them across the unified model
    // (the node itself has no `name`).
    const authors: { name: string; role?: string }[] = (node.authors ?? []).map(
      (p) => ({
        name: `${p.node?.first_name ?? ""} ${p.node?.last_name ?? ""}`.trim(),
        role: p.role,
      })
    );

    return {
      providerId: this.id,
      providerSeriesId,
      title: node.title ?? "Unknown",
      titleOptions: [
        ...new Set<string>(
          [
            node.title,
            node.alternative_titles?.en,
            node.alternative_titles?.ja,
            ...(node.alternative_titles?.synonyms ?? []),
          ].filter(
            (title): title is string =>
              typeof title === "string" && !!title.trim()
          )
        ),
      ],
      year: node.start_date
        ? new Date(node.start_date).getFullYear()
        : undefined,
      releaseDate,
      summary: node.synopsis?.trim(),
      coverUrl: this.coverUrl(node),
      genres: (node.genres ?? [])
        .map((g) => g.name)
        .filter((name): name is string => Boolean(name)),
      tags: (node.tags ?? [])
        .map((t) => t.name)
        .filter((name): name is string => Boolean(name)),
      writers: authors
        .filter((p) => p.role === "Story" || p.role === "Story & Art")
        .map((p) => p.name)
        .filter(Boolean),
      artists: authors
        .filter((p) => p.role === "Art" || p.role === "Story & Art")
        .map((p) => p.name)
        .filter(Boolean),
      readingDirection: "RTL",
      language: "en",
      status: mapMalStatus(node.status),
      url: `https://myanimelist.net/manga/${providerSeriesId}`,
    };
  }
}

function mapMalStatus(status: string | undefined): SeriesMetadata["status"] {
  switch (status) {
    case "currently_publishing":
    case "ongoing":
      return "ONGOING";
    case "finished":
      return "COMPLETED";
    case "hiatus":
      return "HIATUS";
    case "discontinued":
      return "CANCELLED";
    case undefined:
    default:
      return "UNKNOWN";
  }
}

export const myAnimeListProvider: MyAnimeListProvider =
  new MyAnimeListProvider();
