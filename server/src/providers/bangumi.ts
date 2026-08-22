import { BaseProvider, toKavitaRating } from './base.js';
import type { MediaType, SeriesMetadata, SearchResult } from './types.js';

/**
 * Bangumi (bgm.tv) - Chinese/Japanese metadata source. Official public API:
 *   GET /search/subject/{key}?type={1..6}   (2 = manga, 4 = book/novel)
 *   GET /subject/{id}                        (basic subject)
 *   GET /subject/{id}/infobox                (summary, authors, tags)
 */
class BangumiProvider extends BaseProvider {
  id = 'bangumi';
  name = 'Bangumi';
  color = '#c8102e';
  helpUrl = 'https://bgm.tv/wiki/API';
  supportedTypes: MediaType[] = ['MANGA', 'NOVEL'];
  requiresCredentials = false;
  providesFields = ['title', 'summary', 'tags', 'writers', 'rating', 'releaseDate', 'cover'];
  protected baseUrl = 'https://api.bgm.tv';

  /** Bangumi subject type codes: 1=anime 2=manga 3=music 4=book 5=real 6=game */
  private toBangumiType(type?: string): number {
    if (type === 'NOVEL') return 4;
    return 2;
  }

  async testConnection(): Promise<void> {
    const data = await this.get<any>('/search/subject/%E5%85%A8?type=2&limit=1');
    if (!Array.isArray(data)) throw new Error('Bangumi: unexpected response');
  }

  async search(query: string, type?: string): Promise<SearchResult[]> {
    const key = encodeURIComponent(query);
    const data = await this.get<any[]>(`/search/subject/${key}?type=${this.toBangumiType(type)}&limit=20`);
    return (data ?? []).map((s) => ({
      providerId: this.id,
      providerSeriesId: String(s.id),
      title: s.name ?? 'Unknown',
      type: (this.toBangumiType(type) === 4 ? 'NOVEL' : 'MANGA') as SearchResult['type'],
      year: s.date ? new Date(s.date).getFullYear() : undefined,
      coverUrl: s.images?.large ?? s.images?.common,
      summary: s.summary ?? undefined,
    }));
  }

  async getSeriesMetadata(providerSeriesId: string): Promise<SeriesMetadata> {
    const subject = await this.get<any>(`/subject/${providerSeriesId}`);
    if (!subject || subject.id == null) {
      throw new Error(`Bangumi: subject ${providerSeriesId} not found`);
    }
    let infobox: any = {};
    try {
      infobox = await this.get<any>(`/subject/${providerSeriesId}/infobox`);
    } catch {
      infobox = {};
    }

    let releaseDate: string | undefined;
    if (subject.date) {
      const d = new Date(subject.date);
      if (!Number.isNaN(d.getTime())) releaseDate = d.toISOString().slice(0, 10);
    }

    const authors: string[] = [];
    for (const entry of infobox.author ?? []) {
      if (typeof entry === 'string') authors.push(entry);
      else if (entry?.author) authors.push(String(entry.author));
    }

    const tags: string[] = (infobox.tags ?? [])
      .map((t: any) => (typeof t === 'string' ? t : t.name))
      .filter(Boolean);

    return {
      providerId: this.id,
      providerSeriesId,
      title: subject.name ?? 'Unknown',
      sortTitle: subject.name,
      type: (subject.type === 4 ? 'NOVEL' : 'MANGA') as SeriesMetadata['type'],
      year: releaseDate ? Number(releaseDate.slice(0, 4)) : undefined,
      releaseDate,
      summary: (infobox.summary || subject.summary)?.trim(),
      coverUrl: subject.images?.large ?? subject.images?.common,
      genres: [],
      tags,
      writers: authors,
      artists: [],
      publishers: [],
      imprints: [],
      rating: toKavitaRating(subject.rating?.score),
      readingDirection: 'RTL',
      language: 'zh',
      status: 'UNKNOWN',
      url: subject.url ?? `https://bgm.tv/subject/${providerSeriesId}`,
    };
  }
}

export const bangumiProvider: BangumiProvider = new BangumiProvider();
