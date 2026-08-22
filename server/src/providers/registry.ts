import type { MetadataProvider, MediaType } from './types.js';
import { anilistProvider } from './anilist.js';
import { mangaUpdatesProvider } from './mangaupdates.js';
import { mangaDexProvider } from './mangadex.js';
import { myAnimeListProvider } from './myanimelist.js';
import { bangumiProvider } from './bangumi.js';

/**
 * Provider registry: the single source of truth for which metadata sources
 * are available. Adding a new provider = create a module exporting a
 * MetadataProvider instance + register it here.
 */
export const PROVIDERS: MetadataProvider[] = [
  anilistProvider,
  mangaUpdatesProvider,
  mangaDexProvider,
  myAnimeListProvider,
  bangumiProvider,
];

export function getProvider(id: string): MetadataProvider | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

export function getProvidersForType(type: MediaType): MetadataProvider[] {
  return PROVIDERS.filter((p) => p.supportedTypes.includes(type));
}

/** All provider IDs in canonical order (used to seed priorities). */
export function allProviderIds(): string[] {
  return PROVIDERS.map((p) => p.id);
}

export { type MetadataProvider, type MediaType };