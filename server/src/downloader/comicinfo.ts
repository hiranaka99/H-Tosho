import type { DoujinGallery } from './types.js';

/**
 * ComicInfo.xml generation (the CBz standard used by Kavita, Calibre-Web, etc).
 * Text values are wrapped in CDATA so titles/tags with special characters or
 * angle brackets survive a round-trip.
 */

function cdata(value: string): string {
  // CDATA cannot contain the closing sequence `]]>`.
  const safe = String(value ?? '').replace(/\]\]>/g, ']] >');
  return `<![CDATA[${safe}]]>`;
}

function clean(values?: string[]): string {
  if (!values?.length) return '';
  // de-duplicate while preserving order
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const t = String(v ?? '').trim();
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out.join(', ');
}

function pickLanguage(g: DoujinGallery): string {
  // Prefer an explicit `language:` tag when present.
  const langTag = g.tags.find((t) => t.startsWith('language:') && t.length > 'language:'.length);
  if (langTag) return langTag.slice('language:'.length).trim();
  if (g.language && g.language.trim()) return g.language.trim();
  return '';
}

function pickYear(g: DoujinGallery): string {
  const m = /(?:year:)?(\d{4})/.exec(clean(g.tags));
  if (m) return m[1];
  return '';
}

/** Map a doujinshi gallery to the subset of ComicInfo fields we populate. */
export interface ComicInfoFields {
  Title: string;
  Series: string;
  Artist: string;
  Writer: string;
  Summary: string;
  Tags: string;
  Language: string;
  Year: string;
  Web: string;
}

export function buildComicInfoFields(g: DoujinGallery): ComicInfoFields {
  const artists = clean(g.artists);
  // Series is the primary series name, or falls back to the gallery title.
  const series = (g.series ?? '').trim() || g.title.trim();
  return {
    Title: g.title.trim(),
    Series: series,
    Artist: artists,
    Writer: artists, // doujinshi typically credit the same circle for writing
    Summary: clean(g.tags).slice(0, 2000),
    Tags: clean(g.tags),
    Language: pickLanguage(g),
    Year: pickYear(g),
    Web: g.url ?? '',
  };
}

/** Render a full ComicInfo.xml document from a gallery. */
export function generateComicInfoXml(
  g: DoujinGallery,
  opts?: { seriesName?: string; number?: string },
): string {
  const f = buildComicInfoFields(g);
  const series = (opts?.seriesName ?? '').trim() || f.Series;
  const number = (opts?.number ?? '').trim();
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<ComicInfo xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
    `  <Title>${cdata(f.Title)}</Title>`,
    series && `  <Series>${cdata(series)}</Series>`,
    number && `  <Number>${number}</Number>`,
    f.Artist && `  <Artist>${cdata(f.Artist)}</Artist>`,
    f.Writer && `  <Writer>${cdata(f.Writer)}</Writer>`,
    f.Summary && `  <Summary>${cdata(f.Summary)}</Summary>`,
    f.Tags && `  <Tags>${cdata(f.Tags)}</Tags>`,
    f.Language && `  <Language>${cdata(f.Language)}</Language>`,
    f.Year && `  <Year>${f.Year}</Year>`,
    f.Web && `  <Web>${cdata(f.Web)}</Web>`,
    '</ComicInfo>',
  ];
  return lines.filter((l) => l.length > 0).join('\n') + '\n';
}

/** Fields offered in the editor form, in display order. */
export const COMICINFO_EDITOR_FIELDS = [
  'Title',
  'Series',
  'Number',
  'Volume',
  'Artist',
  'Writer',
  'Publisher',
  'Summary',
  'Tags',
  'Language',
  'Year',
  'Web',
] as const;

/** Parsed ComicInfo document: decoded values plus raw inner content for round-tripping. */
export interface ComicInfoDoc {
  /** Tag names in document order (first occurrence). */
  order: string[];
  /** Decoded text value per tag (CDATA unwrapped, nested markup stripped). */
  fields: Record<string, string>;
  /** Raw inner XML per tag — preserves CDATA and nested structures verbatim. */
  rawInner: Record<string, string>;
}

/** Decode a tag's inner content to display text (CDATA unwrapped). */
function decodeValue(inner: string): string {
  const t = inner.trim();
  const m = /^<!\[CDATA\[([\s\S]*)\]\]>$/i.exec(t);
  if (m) return m[1];
  return t.replace(/<[^>]+>/g, '').trim();
}

/**
 * Parse a ComicInfo.xml document into an ordered tag map. Handles the flat
 * scalar layout the format is known for and tolerates nested content (e.g.
 * <Pages>) by keeping its raw inner XML so it survives a round-trip.
 */
export function parseComicInfo(xml: string): ComicInfoDoc {
  const doc: ComicInfoDoc = { order: [], fields: {}, rawInner: {} };
  const open = /<ComicInfo\b[^>]*>/i.exec(xml);
  if (!open) return doc;
  const close = /<\/ComicInfo\s*>/i.exec(xml);
  const body = xml.slice(open.index + open[0].length, close ? close.index : xml.length);

  const tagRe = /<([A-Za-z][\w.-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(body))) {
    const name = m[1];
    const selfClose = m[3] === '/';
    const contentStart = m.index + m[0].length;
    let inner: string;
    if (selfClose) {
      inner = '';
    } else {
      const closeTag = `</${name}>`;
      const closeIdx = body.indexOf(closeTag, contentStart);
      const end = closeIdx >= 0 ? closeIdx : body.length;
      inner = body.slice(contentStart, end);
      // Skip past the closing tag so nested tags are not re-scanned as top level.
      if (closeIdx >= 0) tagRe.lastIndex = closeIdx + closeTag.length;
    }
    if (!doc.order.includes(name)) doc.order.push(name);
    doc.rawInner[name] = inner;
    doc.fields[name] = decodeValue(inner);
  }
  return doc;
}

/**
 * Render a ComicInfo.xml document. Edited tags are emitted from `values`
 * (CDATA-wrapped); untouched tags keep their original raw inner content when
 * provided, so nested/unknown structures round-trip intact. Empty values are
 * omitted, matching the download generator's behavior.
 */
export function renderComicInfoXml(opts: {
  values: Record<string, string>;
  order?: string[];
  rawInner?: Record<string, string>;
  edited?: string[];
}): string {
  const { values, order = [], rawInner = {}, edited = [] } = opts;
  const tags = [...order];
  for (const k of Object.keys(values)) if (!tags.includes(k)) tags.push(k);
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<ComicInfo xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
  ];
  for (const t of tags) {
    if (edited.includes(t)) {
      const v = (values[t] ?? '').trim();
      if (!v) continue;
      lines.push(`  <${t}>${cdata(v)}</${t}>`);
    } else if (rawInner[t] !== undefined) {
      lines.push(`  <${t}>${rawInner[t]}</${t}>`);
    } else {
      const v = (values[t] ?? '').trim();
      if (!v) continue;
      lines.push(`  <${t}>${cdata(v)}</${t}>`);
    }
  }
  lines.push('</ComicInfo>');
  return lines.join('\n') + '\n';
}