import { doujinProviders } from "../downloader/providers.js";
import type { DoujinSuggestion } from "../downloader/types.js";
import { SHARED_FILTERS } from "./unifiedQuery.js";

/** Only offer fragments the shared search parser can represent. One failed
 * source must not hide the other sources' completions. */
export async function unifiedSuggestions(
  query: string,
  limit = 10,
  signal?: AbortSignal
): Promise<DoujinSuggestion[]> {
  const field = /^([a-z]+):(.*)$/is.exec(query.trim());
  const aliases: Record<string, string> = {
    artists: "artist",
    groups: "group",
    circles: "group",
    circle: "group",
    parodies: "parody",
    characters: "character",
    languages: "language",
  };
  const namespace = field
    ? (aliases[field[1].toLowerCase()] ?? field[1].toLowerCase())
    : null;
  if (namespace && !(SHARED_FILTERS as readonly string[]).includes(namespace))
    return [];
  const lookup = field ? `${namespace}:${field[2]}` : query.trim();
  const providers = Object.values(doujinProviders);
  const settled = await Promise.allSettled(
    providers.map(async (provider) => {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const request =
          provider.suggest?.(
            lookup,
            10,
            undefined,
            signal
              ? AbortSignal.any([signal, controller.signal])
              : controller.signal
          ) ?? Promise.resolve([]);
        const deadline = new Promise<DoujinSuggestion[]>((resolve) => {
          timer = setTimeout(() => {
            controller.abort();
            resolve([]);
          }, 2000);
        });
        return await Promise.race([request, deadline]);
      } finally {
        clearTimeout(timer);
      }
    })
  );
  const lanes = settled.map((result) =>
    result.status === "fulfilled" ? result.value : []
  );
  const seen = new Set<string>();
  const out: DoujinSuggestion[] = [];
  for (let rank = 0; rank < 10; rank++) {
    for (const lane of lanes) {
      const suggestion = lane[rank];
      if (
        !suggestion ||
        !(SHARED_FILTERS as readonly string[]).includes(suggestion.type) ||
        (namespace && suggestion.type !== namespace)
      )
        continue;
      const name = (
        suggestion.source === "hitomi"
          ? suggestion.name.replace(/_/g, " ")
          : suggestion.name
      ).trim();
      if (!name || /["\\]/.test(name)) continue;
      const key = `${suggestion.type}:${name.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        source: suggestion.source,
        type: suggestion.type,
        name,
        filter: `${suggestion.type}:"${name}"`,
      });
      if (out.length >= limit) return out;
    }
  }
  return out;
}
