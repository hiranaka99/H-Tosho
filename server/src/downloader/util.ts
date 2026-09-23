import path from 'node:path';

/**
 * Shared helpers for the doujinshi downloader: filename sanitization,
 * JSON extraction from JS payloads, HTML decoding/tag stripping, and URL
 * helpers used by the scraper modules and the queue writer.
 */

/** Strip path separators + illegal filename characters and trim. */
export function sanitizeFilename(name: string, fallback = 'Gallery'): string {
  let out = String(name ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .trim();
  if (!out) out = fallback;
  // Avoid filesystem path traversal via ".." or leading dots.
  out = out.replace(/\.\.+/g, '.');
  if (out.startsWith('.')) out = out.replace(/^\.+/, '');
  if (!out) out = fallback;
  if (out.length > 220) out = out.slice(0, 220).trim();
  return out;
}

/** Stable, readable filesystem name that cannot collide across galleries. */
export function galleryFilesystemName(title: string, source: string, galleryId: string): string {
  const base = sanitizeFilename(title || `Gallery ${galleryId}`, `Gallery-${galleryId}`);
  const identity = sanitizeFilename(`${source}-${galleryId}`, 'gallery').slice(0, 80);
  const suffix = ` [${identity}]`;
  const maxBaseLength = Math.max(1, 220 - suffix.length);
  return `${base.slice(0, maxBaseLength).trim()}${suffix}`;
}

/**
 * Pull the first balanced JSON object out of a blob of text (e.g. a JS file
 * containing `var galleryinfo = { ... };`).
 */
export function extractJsonObject(text: string): unknown | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** Decode the most common HTML entities present in scraped titles/tags. */
export function decodeHtmlEntities(s: string): string {
  return String(s ?? '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity[0] === '#') {
      const hex = entity[1] === 'x' || entity[1] === 'X';
      const code = parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    switch (entity) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      case 'apos':
      case '#39':
        return "'";
      case 'nbsp':
        return ' ';
      default:
        return match;
    }
  });
}

/** Remove HTML tags from a fragment. */
export function stripTags(s: string): string {
  return decodeHtmlEntities(String(s ?? '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** First capture group of a regex match, or null. */
export function cap(text: string, re: RegExp, group = 1): string | null {
  const m = re.exec(text);
  return m ? (m[group] ?? null) : null;
}

/** File extension (lowercase, no dot) from a URL or filename. */
export function extFromUrl(url: string, fallback = 'jpg'): string {
  const clean = url.split('?')[0].split('#')[0];
  const ext = path.extname(clean).replace(/^\./, '').toLowerCase();
  if (!ext || ext.length > 5) return fallback;
  return ext;
}

/** Parse an integer gallery id out of an id/URL string. */
export function extractGalleryId(input: string, urlPattern: RegExp): string | null {
  const trimmed = String(input ?? '').trim();
  if (/^\d+$/.test(trimmed)) return trimmed;
  const m = urlPattern.exec(trimmed);
  if (m) return m[1];
  return null;
}

/** Zero-pad a page number for stable ordering inside archives. */
export function padPage(index: number, total: number): string {
  const width = total >= 1000 ? 4 : total >= 100 ? 3 : 2;
  return String(index).padStart(width, '0');
}

/**
 * Normalize a provider-supplied upload/publish date into an ISO 8601 string
 * (UTC), or undefined when the value is missing/unparseable. Handles the two
 * shapes the doujin sources use:
 *   - nHentai v2 `upload_date`: unix **seconds** (e.g. 1403964737).
 *   - Hitomi `date`: a string like `"2026-08-22 12:53:00-05"` (space separator
 *     and a short `±HH` offset, which is not valid ISO on its own).
 */
export function toIsoDate(raw: unknown): string | undefined {
  if (raw == null || raw === '') return undefined;
  let d: Date;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    // Treat small numbers as unix seconds, large ones as milliseconds.
    const ms = raw < 1e12 ? raw * 1000 : raw;
    d = new Date(ms);
  } else {
    let norm = String(raw).trim().replace(' ', 'T');
    // Only expand an offset on a time; a date-only YYYY-MM-DD ends in -DD.
    norm = norm.replace(/(\d{2}:\d{2}(?::\d{2})?)([+-]\d{2})$/, '$1$2:00');
    d = new Date(norm);
  }
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString();
}
