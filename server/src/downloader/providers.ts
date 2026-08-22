import { hitomiProvider } from './hitomi.js';
import { nhentaiProvider } from './nhentai.js';
import type { DoujinProvider, DoujinSource } from './types.js';

/** Registry of all supported doujinshi sources. */
export const doujinProviders: Record<DoujinSource, DoujinProvider> = {
  hitomi: hitomiProvider,
  nhentai: nhentaiProvider,
};

export function getDoujinProvider(source: string): DoujinProvider | null {
  return doujinProviders[source as DoujinSource] ?? null;
}

export function doujinProviderIds(): DoujinSource[] {
  return Object.keys(doujinProviders) as DoujinSource[];
}

/** List providers with their display metadata (for the UI source selector). */
export function listDoujinProviders(): Array<{ id: DoujinSource; name: string; color: string }> {
  return Object.values(doujinProviders).map((p) => ({ id: p.id, name: p.name, color: p.color }));
}