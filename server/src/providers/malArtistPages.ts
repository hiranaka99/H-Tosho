import { fetchJson, sleep } from '../lib/http.js';
import { decodeHtmlEntities, stripTags as stripHtml } from '../downloader/util.js';
import type { ProviderArtist, ArtistSearchPage, ArtistWorksPage } from '../contracts/artists.js';
import type { SearchResult } from './types.js';

const origin = 'https://myanimelist.net';
const cache = new Map<string, { expires: number; html: string }>();
let tail: Promise<unknown> = Promise.resolve();
let nextAt = 0;

/** Read public MAL pages only; never send API credentials or fetch user URLs. */
async function get<T>(path: string, parse: (html: string) => T): Promise<T> {
  const run = tail.then(async () => {
    const hit = cache.get(path);
    if (hit && hit.expires > Date.now()) return parse(hit.html);
    for (let attempt = 0; ; attempt++) {
      while (nextAt > Date.now()) await sleep(Math.min(60_000, nextAt - Date.now()));
      nextAt = Date.now() + 1_050;
      let response;
      try {
        response = await fetchJson<string>(origin + path, { headers: { Accept: 'text/html' } }, 12_000, { raw: true });
      } catch (error) {
        if (attempt < 2) continue;
        const cause = (error as { cause?: { code?: string } })?.cause?.code;
        const code = typeof cause === 'string' && /^[A-Z_\d]+$/.test(cause) ? ` (${cause})` : '';
        throw new Error(`Could not connect to MyAnimeList${code}. Check the H-Tosho server's DNS and outbound HTTPS connection, then retry.`, { cause: error });
      }
      if (response.status === 429) {
        const raw = response.headers?.get('retry-after') ?? '';
        const retry = Number(raw) * 1000;
        const delay = raw && Number.isFinite(retry) ? retry : Date.parse(raw) - Date.now();
        nextAt = Date.now() + Math.max(60_000, Number.isFinite(delay) ? delay : 0);
        if (attempt < 2) continue;
      }
      if ([502, 503, 504].includes(response.status) && attempt < 2) continue;
      if (response.status >= 400) throw new Error(`MyAnimeList artist browsing failed (HTTP ${response.status}). ${response.status === 403 ? 'MAL blocked this request from the H-Tosho server.' : 'Retry later or open the artist page on MyAnimeList.'}`);
      if (typeof response.data !== 'string') throw new Error('MyAnimeList returned an unexpected artist page. Please retry later.');
      const data = parse(response.data);
      if (cache.size >= 128) cache.delete(cache.keys().next().value!);
      cache.set(path, { expires: Date.now() + 5 * 60_000, html: response.data });
      return data;
    }
  });
  tail = run.catch(() => {});
  return run;
}

function attribute(tag: string, name: string): string {
  return decodeHtmlEntities(tag.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i'))?.[2] ?? '');
}
function artist(id: string, name: string, aliases: string[] = []): ProviderArtist {
  return { providerId: 'myanimelist', artistId: id, name, aliases, url: `${origin}/people/${id}` };
}
function unexpected(): never { throw new Error('MyAnimeList returned an unrecognized artist page. It may be temporarily blocked or its layout has changed. Please retry later.'); }

export function parseMalArtistSearch(html: string, page: number): ArtistSearchPage {
  const section = html.match(/Search Results<\/div>\s*<table\b[^>]*>([\s\S]*?)<\/table>/i)?.[1];
  if (section === undefined) unexpected();
  const items = new Map<string, ProviderArtist>();
  for (const link of section.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = attribute(link[1], 'href');
    const id = href.match(/^(?:https:\/\/myanimelist\.net)?\/people\/(\d+)(?:\/|$)/)?.[1];
    const name = stripHtml(link[2]);
    if (id && name) items.set(id, artist(id, name));
  }
  const nextOffset = page * 50;
  const hasNextPage = [...html.matchAll(/<a\b([^>]*)>/gi)].some(link => {
    const href = attribute(link[1], 'href');
    if (!href.startsWith('/people.php?')) return false;
    return new URL(href, origin).searchParams.get('show') === String(nextOffset);
  });
  return { items: [...items.values()], page, hasNextPage };
}

export function parseMalArtist(html: string, id: string): ProviderArtist {
  const meta = [...html.matchAll(/<meta\b[^>]*>/gi)].find(tag => attribute(tag[0], 'property') === 'og:title');
  const name = meta && attribute(meta[0], 'content');
  if (!name || !/Published Manga/i.test(html)) unexpected();
  const alternate = html.match(/Alternate names:<\/span>([^<]*)/i)?.[1];
  return artist(id, name, alternate ? decodeHtmlEntities(alternate).split(',').map(value => value.trim()).filter(Boolean) : []);
}

export function parseMalArtistWorks(html: string): SearchResult[] {
  if (!/Published Manga/i.test(html)) unexpected();
  const section = html.match(/<table\b[^>]*class=["'][^"']*\bjs-table-people-manga\b[^"']*["'][^>]*>([\s\S]*?)<\/table>/i)?.[1];
  if (section === undefined) {
    if (/No published manga/i.test(html)) return [];
    unexpected();
  }
  const items = new Map<string, SearchResult>();
  for (const row of section.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const link = [...row[1].matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)].find(link => attribute(link[1], 'class').split(/\s+/).includes('js-people-title'));
    if (!link) continue;
    const id = attribute(link[1], 'href').match(/^(?:https:\/\/myanimelist\.net)?\/manga\/(\d+)(?:\/|$)/)?.[1];
    const title = stripHtml(link[2]);
    if (!id || !title) continue;
    const info = stripHtml(row[1].match(/<div\b[^>]*class=["'][^"']*\bmanga-info-text\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1] ?? '');
    const image = row[1].match(/<img\b[^>]*>/i)?.[0] ?? '';
    const src = attribute(image, 'data-src') || attribute(image, 'src');
    let coverUrl: string | undefined;
    try {
      const url = new URL(src, origin);
      if (url.hostname === 'cdn.myanimelist.net' && url.protocol === 'https:') {
        url.pathname = url.pathname.replace(/^\/r\/\d+x\d+\//, '/'); url.search = '';
        coverUrl = url.href;
      }
    } catch { /* A missing cover does not prevent reviewing the work. */ }
    items.set(id, { providerId: 'myanimelist', providerSeriesId: id, title,
      type: /novel/i.test(info) ? 'NOVEL' : /doujinshi/i.test(info) ? 'COMIC' : 'MANGA',
      year: info.match(/\b(?:19|20)\d{2}\b/) ? Number(info.match(/\b(?:19|20)\d{2}\b/)![0]) : undefined, coverUrl });
  }
  if (!items.size && /<tr\b/i.test(section)) unexpected();
  return [...items.values()];
}

export function searchMalArtists(query: string, page = 1): Promise<ArtistSearchPage> {
  return get(`/people.php?${new URLSearchParams({ q: query, show: String((page - 1) * 50) })}`, html => parseMalArtistSearch(html, page));
}
export function getMalArtist(id: string): Promise<ProviderArtist> {
  return get(`/people/${id}`, html => parseMalArtist(html, id));
}
export async function getMalArtistWorks(id: string, page = 1): Promise<ArtistWorksPage> {
  const items = await get(`/people/${id}`, parseMalArtistWorks), offset = (page - 1) * 25;
  return { items: items.slice(offset, offset + 25), page, hasNextPage: offset + 25 < items.length };
}
