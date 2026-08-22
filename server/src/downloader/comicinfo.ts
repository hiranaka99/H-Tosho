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
export function generateComicInfoXml(g: DoujinGallery): string {
  const f = buildComicInfoFields(g);
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<ComicInfo xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
    `  <Title>${cdata(f.Title)}</Title>`,
    f.Series && `  <Series>${cdata(f.Series)}</Series>`,
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