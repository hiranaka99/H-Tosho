/** Title keys for grouping search cards, never replacements for source titles.
 * Leading square-bracket credits are catalogue metadata; chapter, language and
 * edition labels and unknown suffixes remain significant. Censorship labels
 * are retained as an independent part of the group key. */
import { COMMON_LANGUAGE_NAMES } from "./unifiedQuery.js";

const compact = (value: string): string =>
  value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");

function releaseLabel(value: string): boolean {
  return (
    /^(?:un[ -]?censored|de[ -]?censored|censored)(?:\s+(?:ver(?:sion)?\.?|edition|release))?(?:\s+by\s+.+)?$/i.test(
      value.trim()
    ) || /^(?:digital|digital edition|digital version)$/i.test(value.trim())
  );
}

/** Read a complete leading credit, including nested artist/alias brackets. */
function leadingLabel(
  value: string
): { text: string; square: boolean; end: number } | null {
  const pairs: Record<string, string> = { "[": "]", "(": ")", "【": "】" };
  if (!pairs[value[0]]) return null;
  const stack: string[] = [];
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (pairs[char]) stack.push(pairs[char]);
    else if (Object.values(pairs).includes(char)) {
      if (stack.pop() !== char) return null;
      if (!stack.length)
        return {
          text: value.slice(1, index),
          square: value[0] !== "(",
          end: index + 1,
        };
    }
  }
  return null;
}

/** A credit-shaped prefix can still describe an edition rather than its author. */
function meaningfulLabel(value: string): boolean {
  const label = value.trim().toLowerCase();
  return (
    !/[\p{L}\p{N}]/u.test(label) ||
    /^\d+(?:[.\s-]\d+)*$/.test(label) ||
    COMMON_LANGUAGE_NAMES.has(
      label.replace(/\s+(?:translation|translated)$/, "")
    ) ||
    /^(?:ch(?:apter)?s?\.?|vol(?:ume)?s?\.?|parts?|pt\.?|episodes?|ep\.?|books?|issues?|no\.?|seasons?|ver(?:sion)?\.?|v)(?=$|[\s\d._:#-])/i.test(
      label
    ) ||
    /\b(?:colou?r(?:ized|ised|ed)?|monochrome|gr[ae]yscale|rewrite|rewritten|redraw|redrawn|revised|revision|remake|reprint|edition|version|translation|translated|translator|scanlation|textless|uncensored|decensored|censored)\b/i.test(
      label
    ) ||
    /^(?:compilation|collection|anthology|omnibus|complete|incomplete|ongoing|extras?|bonus|omake|samples?|preview)$/i.test(
      label
    ) ||
    /^(?:b\s*[/&]\s*w|black\s*(?:and|&)\s*white|raw)$/i.test(label)
  );
}

/** Censorship edition read from title labels and, optionally, source tags. */
export type CensorshipEdition =
  "uncensored" | "censored" | "unmarked" | "mixed";

/** Source tags that state an edition: nHentai/Hitomi `uncensored`, E-Hentai `other:uncensored` / `other:mosaic censorship`. */
function tagCensorship(tag: string): "uncensored" | "censored" | null {
  const name = tag
    .normalize("NFKC")
    .toLowerCase()
    .replace(/^[a-z]+:/, "")
    .replace(/_/g, " ")
    .trim();
  if (/^(?:un|de)[ -]?censored$/.test(name)) return "uncensored";
  if (
    name === "censored" ||
    name === "mosaic censorship" ||
    name === "bar censorship"
  )
    return "censored";
  return null;
}

/**
 * Absence of a label says nothing about censorship. Conflicting labels
 * likewise must not silently join either explicit edition.
 */
export function censorshipEdition(
  titles: readonly string[],
  tags: readonly string[] = []
): CensorshipEdition {
  const labels = new Set<string>();
  for (const title of titles) {
    for (const match of title
      .normalize("NFKC")
      .matchAll(/\b(?:un[ -]?censored|de[ -]?censored|censored)\b/gi)) {
      labels.add(
        match[0].toLowerCase() === "censored" ? "censored" : "uncensored"
      );
    }
  }
  for (const tag of tags) {
    const edition = tagCensorship(tag);
    if (edition) labels.add(edition);
  }
  return labels.size > 1
    ? "mixed"
    : (([...labels][0] as CensorshipEdition | undefined) ?? "unmarked");
}

/** Remove censorship release labels so two editions of one work share a title. */
export function withoutCensorshipLabels(title: string): string {
  return title
    .normalize("NFKC")
    .replace(
      /\s*[[(【]\s*(?:un[ -]?censored|de[ -]?censored|censored)(?:\s+(?:ver(?:sion)?\.?|edition|release))?(?:\s+by\s+[^\])】]+)?\s*[\])】]/gi,
      " "
    )
    .replace(
      /\s+[-–—|]\s+(?:un[ -]?censored|de[ -]?censored|censored)(?:\s+(?:ver(?:sion)?\.?|edition|release))?\s*$/i,
      ""
    )
    .replace(/\s+/g, " ")
    .trim();
}

export function unifiedTitleKey(
  title: string,
  artists: string[],
  language: string
): string {
  const edition = censorshipEdition([title]);
  const names = new Set(artists.map(compact).filter(Boolean));
  const languageLabels = new Set([language]);
  if (language === "english") languageLabels.add("en");
  const annotation = (value: string): boolean => {
    const text = value.trim().toLowerCase();
    return (
      releaseLabel(text) ||
      languageLabels.has(text.replace(/\s+(?:translation|translated)$/, ""))
    );
  };
  let core = title
    .normalize("NFKC")
    .replace(
      /\[([^[\]]*)\]|\(([^()]*)\)|【([^【】]*)】/gu,
      (
        whole,
        square: string | undefined,
        round: string | undefined,
        corner: string | undefined
      ) => (annotation(square ?? round ?? corner ?? "") ? " " : whole)
    );
  // Catalogue grammar, independent of artist spelling or the search query:
  // [Artist], [Circle], [Circle (Artist)] and stacked credits precede the work.
  // Metadata artist/language/page-count agreement is enforced by the caller.
  // Ordinary parenthesized title text and meaningful edition labels survive.
  const retained: string[] = [];
  for (;;) {
    core = core.trimStart();
    const prefix = leadingLabel(core);
    if (!prefix) break;
    const event = /^(?:c|comiket|comic market)\s*\d+$/i.test(
      prefix.text.trim()
    );
    const credit =
      names.has(compact(prefix.text)) ||
      (prefix.square && !meaningfulLabel(prefix.text));
    if (!event && !credit) retained.push(core.slice(0, prefix.end));
    core = core.slice(prefix.end);
  }
  core = [...retained, core].join(" ");
  // Also recognize an explicitly separated edition suffix, not ordinary words
  // in titles such as "Uncensored Love".
  const suffix = /\s+[-–—|]\s+([^[\]()【】]+)\s*$/u.exec(core);
  if (suffix && releaseLabel(suffix[1])) core = core.slice(0, suffix.index);
  const normalized = compact(core);
  return normalized ? `${edition}:${normalized}` : "";
}
