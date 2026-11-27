import { hitomiProvider } from "./hitomi.js";
import { nhentaiProvider } from "./nhentai.js";
import { ehentaiProvider } from "./ehentai.js";
import type { DoujinProvider } from "./types.js";
import {
  isEhentaiSite,
  type DoujinSource,
  type EhentaiSite,
} from "../contracts/doujin.js";

/** Registry of all supported doujinshi sources. */
export const doujinProviders: Record<DoujinSource, DoujinProvider> = {
  hitomi: hitomiProvider,
  nhentai: nhentaiProvider,
  ehentai: ehentaiProvider,
};

export function getDoujinProvider(source: string): DoujinProvider | null {
  return doujinProviders[source as DoujinSource] ?? null;
}

/** List providers with their display metadata (for the UI source selector).
 *  For `ehentai`, `site`/`displayName` reflect the currently selected family
 *  site (E-Hentai / ExHentai) without ever exposing session values. */
export function listDoujinProviders(ehentaiSite?: string): Array<{
  id: DoujinSource;
  name: string;
  color: string;
  sorts: string[];
  paging: "offset" | "cursor";
  site?: EhentaiSite;
  displayName?: string;
}> {
  return Object.values(doujinProviders).map((p) => {
    const base = {
      id: p.id,
      name: p.name,
      color: p.color,
      sorts: p.meta.sorts,
      paging: p.meta.paging,
    };
    if (p.id === "ehentai") {
      const site = isEhentaiSite(ehentaiSite) ? ehentaiSite : "e-hentai";
      return {
        ...base,
        site,
        displayName: site === "exhentai" ? "ExHentai" : "E-Hentai",
      };
    }
    return base;
  });
}
