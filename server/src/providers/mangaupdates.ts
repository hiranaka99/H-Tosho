import { BaseProvider, toKavitaRating } from './base.js';
import type { MediaType, SeriesMetadata, SearchResult } from './types.js';

/**
 * MangaUpdates — manga/light-novel database. No stable JSON API, so we parse
 * the public HTML. Tolerant by design: layout drift degrades to empty results.
 */
class MangaUpdatesProvider extends BaseProvider {
  id = 'mangaupdates';
  name = 'MangaUpdates';
  color = '#f47a20';
  helpUrl = 'https://www.mangaupdates.com/';
  supportedTypes: MediaType[] = ['MANGA', 'NOVEL', 'COMIC', 'WEBTOON'];
  requiresCredentials = false;
  providesFields = ['title', 'summary', 'genres', 'writers', 'publishers', 'releaseDate', 'status', 'cover'];
  protected baseUrl = 'https://www.mangaupdates.com';

  private headers(): Record<string, string> {
    return {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    };
  }

  private async getHtml(path: string): Promise<string> {
    const url = this.baseUrl.replace(/\/+$/, '') + path;
    // MangaUpdates aggressively rate-limits (429). Retry with backoff so a
    // burst of syncs doesn't fail the whole run.
    const attempts = 3;
    for (let i = 0; ; i++) {
      const res = await fetch(url, { headers: this.headers(), redirect: 'follow' });
      if (res.status === 429 && i < attempts - 1) {
        await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
        continue;
      }
      if (res.status >= 400) throw new Error(`MangaUpdates request failed (HTTP ${res.status})`);
      return await res.text();
    }
  }

  async testConnection(): Promise<void> {
    const html = await this.getHtml('/series');
    if (!/mangaupdates/i.test(html)) throw new Error('MangaUpdates: unexpected response');
  }

  async search(query: string, type?: string): Promise<SearchResult[]> {
    const params = new URLSearchParams({ s: query, sb: 't', sm: 'p', dt: '100' });
    if (type === 'NOVEL') params.set('lt', '1');
    else if (type === 'MANGA') params.set('lt', '2');
    const html = await this.getHtml(`/search?${params.toString()}`);
    return parseSearchResults(html, this.id);
  }

  async getSeriesMetadata(providerSeriesId: string): Promise<SeriesMetadata> {
    const html = await this.getHtml(`/series/${providerSeriesId}`);
    const meta = parseSeriesDetail(html, this.id);
    if (!meta) throw new Error('MangaUpdates: could not parse series page');
    return meta;
  }
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function getMeta(html: string, name: string): string | undefined {
  const re = new RegExp(
    `<meta[^>]+name=["']${name}["'][^>]+content=["']([^"']*)["']|<meta[^>]+content=["']([^"']*)["'][^>]+name=["']${name}["']`,
    'i',
  );
  const m = re.exec(html);
  return m ? m[1] || m[2] : undefined;
}

export function parseSearchResults(html: string, providerId: string): SearchResult[] {
  const results: SearchResult[] = [];
  const seen = new Set<string>();

  // Primary: full <a> cards (slug + inner title/cover). Tolerant of layout drift.
  const cardRe = /<a[^>]+href=["']\/series\/([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = cardRe.exec(html)) !== null && results.length < 20) {
    const slug = m[1];
    if (seen.has(slug) || /\/series$/.test(slug)) continue;
    seen.add(slug);
    const inner = m[2];
    const title = stripTags(inner).split('\n')[0].trim();
    if (!title || title.length < 2) continue;
    const cover = (inner.match(/src=["']([^"']+\.(?:jpg|jpeg|png|webp))["']/i) ?? [])[1];
    results.push({
      providerId,
      providerSeriesId: slug,
      title,
      type: 'MANGA',
      coverUrl: cover,
    });
  }

  // Fallback: if the card regex found nothing (markup drift), pull bare /series/ links.
  if (results.length === 0) {
    const linkRe = /href=["']\/series\/([a-z0-9][a-z0-9-]+)["']/gi;
    while ((m = linkRe.exec(html)) !== null && results.length < 20) {
      const slug = m[1];
      if (seen.has(slug)) continue;
      seen.add(slug);
      results.push({
        providerId,
        providerSeriesId: slug,
        title: slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
        type: 'MANGA',
      });
    }
  }

  return results;
}

export function parseSeriesDetail(html: string, providerId: string): SeriesMetadata | null {
  const slugMatch = /<a[^>]+href=["']\/series\/([^"']+)["']/i.exec(html);
  const slug = slugMatch?.[1];
  if (!slug) return null;

  const title = getMeta(html, 'og:title') ?? 'Unknown';
  const summary = getMeta(html, 'og:description') ?? getMeta(html, 'description');
  const cover = getMeta(html, 'og:image');
  const url = `https://www.mangaupdates.com/series/${slug}`;

  const genres: string[] = [];
  const genreRe = /href=["']\/genre\/[^"']+["'][^>]*>([^<]+)<\/a>/gi;
  let gm: RegExpExecArray | null;
  while ((gm = genreRe.exec(html)) !== null) {
    const g = gm[1].trim();
    if (g && !genres.includes(g) && genres.length < 30) genres.push(g);
  }

  const people: string[] = [];
  const personRe = /href=["']\/profile\/[^"']+["'][^>]*>([^<]+)<\/a>/gi;
  let pm: RegExpExecArray | null;
  while ((pm = personRe.exec(html)) !== null) {
    const p = pm[1].trim();
    if (p && !people.includes(p) && people.length < 30) people.push(p);
  }

  let releaseDate: string | undefined;
  const flat = stripTags(html);
  const dateMatch =
    /Released:?\s*([0-9]{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+[0-9]{4})/i.exec(
      flat,
    );
  if (dateMatch) {
    const d = new Date(dateMatch[1]);
    if (!Number.isNaN(d.getTime())) releaseDate = d.toISOString().slice(0, 10);
  }

  const lower = flat.toLowerCase();
  const status = lower.includes('ongoing')
    ? 'ONGOING'
    : lower.includes('completed')
      ? 'COMPLETED'
      : lower.includes('hiatus')
        ? 'HIATUS'
        : lower.includes('cancelled') || lower.includes('canceled')
          ? 'CANCELLED'
          : 'UNKNOWN';

  return {
    providerId,
    providerSeriesId: slug,
    title,
    type: 'MANGA',
    summary: summary?.trim(),
    coverUrl: cover,
    genres,
    tags: [],
    writers: people,
    artists: [],
    publishers: [],
    imprints: [],
    releaseDate,
    status: status as SeriesMetadata['status'],
    readingDirection: 'RTL',
    language: 'en',
    url,
  };
}

export const mangaUpdatesProvider: MangaUpdatesProvider = new MangaUpdatesProvider();
