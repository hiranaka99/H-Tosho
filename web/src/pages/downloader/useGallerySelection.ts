import * as React from 'react';
import type { DoujinSearchResult } from '../../lib/api';
import { indexSelectableGalleries, selectedGalleryItems } from '../../lib/gallerySelection';
const keyOf = (item: DoujinSearchResult) => `${item.source}:${item.galleryId}`;

export function resolveGallerySelection(chosen: ReadonlyMap<string, DoujinSearchResult>, results: readonly DoujinSearchResult[], discoveries: readonly DoujinSearchResult[], knownDiscoveries: ReadonlySet<string>) {
  const keys = new Set(chosen.keys());
  const index = indexSelectableGalleries([...chosen.values(), ...results], [...discoveries]);
  const items = selectedGalleryItems(index, keys);
  const currentDiscoveries = new Set(discoveries.map(keyOf));
  return { items, reviewable: items.filter(item => knownDiscoveries.has(keyOf(item)) || currentDiscoveries.has(keyOf(item))) };
}

export function useGallerySelection() {
  const [chosen, setChosen] = React.useState(new Map<string, DoujinSearchResult>());
  const keys = React.useMemo(() => new Set(chosen.keys()), [chosen]);
  const toggle = React.useCallback((item: DoujinSearchResult) => {
    setChosen(previous => {
      const next = new Map(previous), key = keyOf(item);
      if (next.has(key)) next.delete(key); else next.set(key, item);
      return next;
    });
  }, []);
  /** Adds items that are not yet chosen, keeping click order for the rest. */
  const addMany = React.useCallback((items: readonly DoujinSearchResult[]) => {
    setChosen(previous => {
      const next = new Map(previous);
      for (const item of items) if (!next.has(keyOf(item))) next.set(keyOf(item), item);
      return next.size === previous.size ? previous : next;
    });
  }, []);
  const remove = React.useCallback((handled: ReadonlySet<string>) => setChosen(previous => new Map([...previous].filter(([key]) => !handled.has(key)))), []);
  const clear = React.useCallback(() => setChosen(new Map()), []);
  return { keys, chosen, toggle, addMany, remove, clear };
}
