import type { SearchResult } from "../providers/types.js";

export type ArtistProviderId = "anilist" | "mangadex" | "myanimelist";
export interface ProviderArtist {
  providerId: ArtistProviderId;
  artistId: string;
  name: string;
  aliases: string[];
  url: string;
}
export interface ProviderPage<T> {
  items: T[];
  page: number;
  hasNextPage: boolean;
}
export type ArtistSearchPage = ProviderPage<ProviderArtist>;
export type ArtistWorksPage = ProviderPage<SearchResult>;

/** Artist URLs identify records only. The server never fetches a supplied URL. */
export function parseProviderArtistUrl(
  raw: string
): { providerId: ArtistProviderId; artistId: string } | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.port
  )
    return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const [kind, id] = url.pathname.split("/").filter(Boolean);
  if (
    host === "anilist.co" &&
    kind === "staff" &&
    /^\d+$/.test(id ?? "") &&
    Number.isSafeInteger(Number(id)) &&
    Number(id) > 0
  )
    return { providerId: "anilist", artistId: String(Number(id)) };
  if (
    host === "myanimelist.net" &&
    kind === "people" &&
    /^\d+$/.test(id ?? "") &&
    Number.isSafeInteger(Number(id)) &&
    Number(id) > 0
  )
    return { providerId: "myanimelist", artistId: String(Number(id)) };
  if (
    host === "mangadex.org" &&
    kind === "author" &&
    /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id ?? "")
  )
    return { providerId: "mangadex", artistId: id.toLowerCase() };
  return null;
}
