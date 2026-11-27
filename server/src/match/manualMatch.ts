import type { MediaType } from "../providers/types.js";

export interface ManualProviderReference {
  providerId: string;
  providerSeriesId: string;
  type: MediaType;
}

const MANGADEX_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NUMERIC_ID = /^\d+$/;

/** Parse a supported provider series URL without accepting arbitrary hosts or paths. */
export function parseManualProviderUrl(
  raw: string
): ManualProviderReference | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;

  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const parts = url.pathname.split("/").filter(Boolean);

  if (
    host === "mangadex.org" &&
    parts[0] === "title" &&
    MANGADEX_ID.test(parts[1] ?? "")
  ) {
    return {
      providerId: "mangadex",
      providerSeriesId: parts[1].toLowerCase(),
      type: "MANGA",
    };
  }
  if (
    host === "myanimelist.net" &&
    parts[0] === "manga" &&
    NUMERIC_ID.test(parts[1] ?? "")
  ) {
    return {
      providerId: "myanimelist",
      providerSeriesId: parts[1],
      type: "MANGA",
    };
  }
  if (
    host === "anilist.co" &&
    parts[0] === "manga" &&
    NUMERIC_ID.test(parts[1] ?? "")
  ) {
    return { providerId: "anilist", providerSeriesId: parts[1], type: "MANGA" };
  }
  return null;
}
