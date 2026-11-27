import { Hono } from "hono";
import { getProvider } from "../../providers/registry.js";
import { getCredentialMap } from "../../services/settings.js";
import { parseProviderArtistUrl } from "../../contracts/artists.js";
import { rewriteMangaDexCoverUrl } from "../media.js";
import { errMsg } from "./helpers.js";

export const api = new Hono();
const validPage = (value: string | undefined) => {
  const page = Number(value ?? 1);
  return Number.isSafeInteger(page) && page >= 1 && page <= 200 ? page : null;
};

api.get("/providers/:id/artists", async (c) => {
  const id = c.req.param("id"),
    provider = getProvider(id),
    page = validPage(c.req.query("page"));
  const query = (c.req.query("query") ?? "").trim();
  if (!provider?.searchArtists || !provider.getArtist)
    return c.json(
      {
        error:
          "Artist browsing is available for AniList, MangaDex, and MyAnimeList.",
      },
      400
    );
  if (page === null || !query || query.length > 500)
    return c.json(
      {
        error:
          "Enter an artist name or supported artist URL, and a page between 1 and 200.",
      },
      400
    );
  const { credentials, enabledProviders } = getCredentialMap();
  if (!enabledProviders.includes(id))
    return c.json(
      {
        error: `${provider.name} is disabled. Enable it in Settings to browse artists.`,
      },
      409
    );
  const reference = parseProviderArtistUrl(query);
  if (reference && reference.providerId !== id)
    return c.json(
      {
        error: `Select ${getProvider(reference.providerId)?.name} to use this artist URL.`,
      },
      400
    );
  if (!reference && /^[a-z][a-z\d+.-]*:/i.test(query))
    return c.json(
      {
        error:
          "Use an AniList staff, MangaDex author, or MyAnimeList people URL.",
      },
      400
    );
  try {
    provider.setCredentials(credentials[id] ?? {});
    if (reference)
      return c.json({
        items: page === 1 ? [await provider.getArtist(reference.artistId)] : [],
        page,
        hasNextPage: false,
      });
    return c.json(await provider.searchArtists(query, page));
  } catch (error) {
    return c.json({ error: errMsg(error) }, 502);
  }
});

api.get("/providers/:id/artists/:artistId/works", async (c) => {
  const id = c.req.param("id"),
    provider = getProvider(id),
    page = validPage(c.req.query("page"));
  if (!provider?.getArtistWorks)
    return c.json(
      {
        error:
          "Artist browsing is available for AniList, MangaDex, and MyAnimeList.",
      },
      400
    );
  const artistId = c.req.param("artistId");
  const reference = parseProviderArtistUrl(
    id === "anilist"
      ? `https://anilist.co/staff/${artistId}`
      : id === "myanimelist"
        ? `https://myanimelist.net/people/${artistId}`
        : `https://mangadex.org/author/${artistId}`
  );
  if (
    !reference ||
    reference.artistId !== artistId.toLowerCase() ||
    page === null
  )
    return c.json({ error: "Invalid artist ID or page." }, 400);
  const { credentials, enabledProviders } = getCredentialMap();
  if (!enabledProviders.includes(id))
    return c.json(
      {
        error: `${provider.name} is disabled. Enable it in Settings to browse artists.`,
      },
      409
    );
  try {
    provider.setCredentials(credentials[id] ?? {});
    const result = await provider.getArtistWorks(reference.artistId, page);
    return c.json({
      ...result,
      items: result.items.map((item) => ({
        ...item,
        coverUrl: rewriteMangaDexCoverUrl(item.coverUrl),
      })),
    });
  } catch (error) {
    return c.json({ error: errMsg(error) }, 502);
  }
});
