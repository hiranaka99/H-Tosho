import type { DoujinSort } from "./types.js";

export interface HitomiSearchState {
  area: string;
  tag: string;
  language: string;
  orderby: "date" | "popular";
  orderbykey: string;
  direction: string;
}

export function normalizeHitomiQuery(query: string): string {
  const punctuation: Record<string, string> = {
    "“": '"',
    "”": '"',
    "‘": "'",
    "’": "'",
    "–": "-",
    "—": "-",
  };
  return query
    .replace(/[“”‘’–—]/g, (char) => punctuation[char])
    .toLowerCase()
    .trim();
}

/** Official results.js grammar, with H-Tosho's existing default language. */
export function parseHitomiSearch(
  query: string,
  sort?: DoujinSort,
  defaultLanguage = "english"
) {
  const terms = normalizeHitomiQuery(query).split(/\s+/).filter(Boolean);
  // Equivalent to adding the user's default language to the website query.
  const lang = defaultLanguage.trim().toLowerCase() || "english";
  if (!terms.some((term) => term.startsWith("language:")))
    terms.push(`language:${lang}`);
  const state: HitomiSearchState = {
    area: "all",
    tag: "index",
    language: "all",
    orderby: "date",
    orderbykey: "",
    direction: "desc",
  };
  if (sort?.startsWith("popular")) {
    state.orderby = "popular";
    state.orderbykey =
      sort === "popular" ? "year" : sort.slice("popular-".length);
  } else if (sort === "date-published") state.orderbykey = "published";
  else if (sort === "random") state.direction = "random";
  const positive: string[] = [],
    negative: string[] = [];
  const groups: string[][] = [[]];
  terms.forEach((raw, index) => {
    const term = raw.replace(/_/g, " ");
    if (/^(?:sort|order)by(?:key|direction)?:/.test(term)) {
      const [key, value = ""] = term.split(":");
      if (/^(?:sort|order)bykey$/.test(key))
        state.orderbykey = value.replace(/[^0-9a-z]/g, "");
      else if (value === "popular" || value === "popularity")
        state.orderby = "popular";
      else if (value === "date") state.orderby = "date";
      else if (value === "datepublished") {
        state.orderby = "date";
        state.orderbykey = "published";
      } else if (
        /^(?:sort|order)by$/.test(key) &&
        ["random", "rand"].includes(value)
      )
        state.direction = "random";
      else if (/^(?:sort|order)bydirection$/.test(key))
        state.direction = value.replace(/[^0-9a-z]/g, "");
      return;
    }
    if (term === "or") return;
    const orNext = terms[index + 1] === "or";
    if (terms[index - 1] === "or" || orNext) {
      groups[groups.length - 1].push(term);
      if (!orNext) groups.push([]);
    } else if (term.startsWith("-")) negative.push(term.slice(1));
    else positive.push(term);
  });
  positive.sort((a, b) => Number(b.includes(":")) - Number(a.includes(":")));
  if (!state.orderbykey)
    state.orderbykey = state.orderby === "popular" ? "year" : "added";
  return {
    state,
    positive,
    negative,
    groups: groups.filter((group) => group.length),
  };
}

export function hitomiStateForTerm(
  term: string,
  state: HitomiSearchState
): HitomiSearchState {
  const [namespace, value] = term.split(":");
  if (namespace === "female" || namespace === "male")
    return { ...state, area: "tag", tag: term };
  if (namespace === "language") return { ...state, language: value };
  return { ...state, area: namespace, tag: value };
}

export function hitomiNozomiPath(state: HitomiSearchState): string {
  const suffix = `${state.tag}-${state.language}.nozomi`;
  if (state.orderby !== "date" || state.orderbykey === "published") {
    return state.area === "all"
      ? `/n/${state.orderby}/${state.orderbykey}-${state.language}.nozomi`
      : `/n/${state.area}/${state.orderby}/${state.orderbykey}/${suffix}`;
  }
  return state.area === "all" ? `/n/${suffix}` : `/n/${state.area}/${suffix}`;
}
