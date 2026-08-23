import { fetchJson, fetchBuffer } from '../lib/http.js';
import type {
  MetadataProvider,
  MediaType,
  ProviderCredentials,
  SeriesMetadata,
  SearchResult,
} from './types.js';

/**
 * Base class offering shared HTTP helpers for providers. Concrete providers
 * extend this and implement the `MetadataProvider` interface.
 */
export abstract class BaseProvider implements MetadataProvider {
  abstract id: string;
  abstract name: string;
  abstract color: string;
  helpUrl?: string;
  abstract supportedTypes: MediaType[];
  abstract requiresCredentials: boolean;
  abstract providesFields: string[];

  abstract search(query: string, type?: MediaType): Promise<SearchResult[]>;
  abstract getSeriesMetadata(providerSeriesId: string): Promise<SeriesMetadata>;

  protected credentials: ProviderCredentials = {};

  setCredentials(credentials: ProviderCredentials): void {
    this.credentials = { ...credentials };
  }

  getCredentials(): ProviderCredentials {
    return { ...this.credentials };
  }

  protected abstract baseUrl: string;

  /** Extract a short human-readable error detail from an API response body. */
  protected describeError(status: number, data: unknown): string {
    let detail = '';
    if (data && typeof data === 'object') {
      const o = data as Record<string, any>;
      detail =
        o?.message ??
        o?.detail ??
        (Array.isArray(o?.errors) ? o.errors[0]?.message : undefined) ??
        (o?.errors?.[0]?.detail ?? '');
    } else if (typeof data === 'string') {
      detail = data;
    }
    return `${this.name} request failed (HTTP ${status})${detail ? `: ${String(detail).slice(0, 240)}` : ''}`;
  }

  protected async get<T>(path: string, init: RequestInit = {}, timeoutMs = 20_000): Promise<T> {
    const url = this.baseUrl.replace(/\/+$/, '') + path;
    const res = await fetchJson<T>(url, init, timeoutMs, { raw: true });
    if (res.status >= 400) {
      throw new Error(this.describeError(res.status, res.data));
    }
    return res.data;
  }

  protected async getPost<T>(path: string, body: unknown, headers: Record<string, string>): Promise<T> {
    const url = this.baseUrl.replace(/\/+$/, '') + path;
    const res = await fetchJson<T>(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }, 15_000, { raw: true });
    if (res.status >= 400) {
      throw new Error(this.describeError(res.status, res.data));
    }
    return res.data;
  }

  protected async getImage(url: string): Promise<Buffer | null> {
    try {
      return await fetchBuffer(url, { headers: { 'User-Agent': 'H-Tosho/1.0' } }, 30_000);
    } catch {
      return null;
    }
  }

  async testConnection(): Promise<void> {
    // Default: providers with no credentials are trivially "connected".
    if (!this.requiresCredentials) return;
    // Concrete providers override to perform a real validation call.
  }
}

/**
 * Coercion helpers shared by providers mapping raw API values into the
 * unified model.
 */
export function toMediaType(raw: string | undefined, fallback: MediaType = 'MANGA'): MediaType {
  const v = (raw ?? '').toUpperCase();
  if (v.includes('NOVEL') || v.includes('LIGHT_NOVEL') || v.includes('LIGHT NOVEL')) return 'NOVEL';
  if (v.includes('WEBTOON') || v.includes('WEB COMIC')) return 'WEBTOON';
  if (v.includes('COMIC')) return 'COMIC';
  if (v.includes('MANGA')) return 'MANGA';
  return fallback;
}

/** Map a numeric rating (0-10) into Kavita's 0-5 star scale. */
export function toKavitaRating(score: number | undefined): number | undefined {
  if (score == null || Number.isNaN(score)) return undefined;
  return Math.max(0, Math.min(5, Math.round(score / 2)));
}

export type { MetadataProvider, MediaType, ProviderCredentials, SeriesMetadata, SearchResult };