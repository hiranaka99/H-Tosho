import { fetchJson, sleep } from '../lib/http.js';
import type { ProviderArtist, ArtistSearchPage, ArtistWorksPage } from '../contracts/artists.js';
import type { SearchResult } from './types.js';

const origin = 'https://api.jikan.moe/v4';
const cache = new Map<string, { expires: number; data: unknown }>();
let tail: Promise<unknown> = Promise.resolve();
let nextAt = 0;

/** Public people data only: never forward MAL credentials to Jikan. */
async function get<T>(path: string): Promise<T> {
  const run = tail.then(async () => {
    const hit = cache.get(path);
    if (hit && hit.expires > Date.now()) return hit.data as T;
    for (let attempt = 0; ; attempt++) {
      while (nextAt > Date.now()) await sleep(Math.min(60_000, nextAt - Date.now()));
      nextAt = Date.now() + 1_050;
      const response = await fetchJson<T & { message?: string }>(origin + path, {}, 20_000, { raw: true });
      if (response.status === 429) {
        const raw = response.headers?.get('retry-after') ?? '';
        const retry = Number(raw) * 1000;
        const delay = raw && Number.isFinite(retry) ? retry : Date.parse(raw) - Date.now();
        nextAt = Date.now() + Math.max(60_000, Number.isFinite(delay) ? delay : 0);
        if (attempt < 2) continue;
      }
      if (response.status >= 400) throw new Error(`MyAnimeList artist browsing via Jikan failed (HTTP ${response.status})${response.data?.message ? `: ${response.data.message}` : ''}`);
      if (cache.size >= 128) cache.delete(cache.keys().next().value!);
      cache.set(path, { expires: Date.now() + 5 * 60_000, data: response.data });
      return response.data;
    }
  });
  tail = run.catch(() => {});
  return run;
}

interface Person { mal_id: number; name: string; alternate_names?: string[] }
function artist(person: Person): ProviderArtist {
  return { providerId: 'myanimelist', artistId: String(person.mal_id), name: person.name,
    aliases: person.alternate_names ?? [], url: `https://myanimelist.net/people/${person.mal_id}` };
}
export async function searchMalArtists(query: string, page = 1): Promise<ArtistSearchPage> {
  const result = await get<{ data: Person[]; pagination?: { has_next_page?: boolean } }>(`/people?${new URLSearchParams({ q: query, page: String(page), limit: '25' })}`);
  return { items: result.data.map(artist), page, hasNextPage: result.pagination?.has_next_page ?? false };
}
export async function getMalArtist(id: string): Promise<ProviderArtist> {
  return artist((await get<{ data: Person }>(`/people/${id}`)).data);
}
export async function getMalArtistWorks(id: string, page = 1): Promise<ArtistWorksPage> {
  // This endpoint returns the entire mangaography, without upstream pagination.
  const result = await get<{ data: { manga: { mal_id: number; title: string; images?: { jpg?: { large_image_url?: string; image_url?: string } } } }[] }>(`/people/${id}/manga`);
  const unique = new Map<string, SearchResult>();
  for (const { manga } of result.data) {
    if (!manga?.mal_id || !manga.title) continue;
    const key = String(manga.mal_id);
    unique.set(key, { providerId: 'myanimelist', providerSeriesId: key, title: manga.title,
      type: 'MANGA', coverUrl: manga.images?.jpg?.large_image_url ?? manga.images?.jpg?.image_url });
  }
  const items = [...unique.values()], offset = (page - 1) * 25;
  return { items: items.slice(offset, offset + 25), page, hasNextPage: offset + 25 < items.length };
}
