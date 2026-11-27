import * as React from "react";

interface SharedQuery {
  list: MediaQueryList;
  listeners: Set<() => void>;
  onChange: () => void;
}

/** One MediaQueryList (and one native listener) per query string, shared by every subscriber. */
const queries = new Map<string, SharedQuery>();

function sharedQuery(query: string): SharedQuery {
  let entry = queries.get(query);
  if (!entry) {
    const listeners = new Set<() => void>();
    entry = {
      list: window.matchMedia(query),
      listeners,
      onChange: () => listeners.forEach((listener) => listener()),
    };
    queries.set(query, entry);
  }
  return entry;
}

export function useMediaQuery(query: string): boolean {
  const subscribe = React.useCallback(
    (listener: () => void) => {
      const entry = sharedQuery(query);
      if (entry.listeners.size === 0)
        entry.list.addEventListener("change", entry.onChange);
      entry.listeners.add(listener);
      return () => {
        entry.listeners.delete(listener);
        if (entry.listeners.size === 0)
          entry.list.removeEventListener("change", entry.onChange);
      };
    },
    [query]
  );
  const getSnapshot = React.useCallback(
    () => sharedQuery(query).list.matches,
    [query]
  );
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
