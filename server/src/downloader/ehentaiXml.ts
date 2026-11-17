/**
 * Purpose-specific parser for the E-Hentai `gdata` API response
 * (`https://api.e-hentai.org/api.php?t=gdata`).
 *
 * The API returns an XML document of this exact shape:
 *
 *   <gmetadata>
 *     <g>
 *       <f t="token">abcdef012345</f>
 *       <f t="file_count">12</f>
 *       <f t="category">Doujinshi</f>
 *       <f t="language">English</f>
 *       <f t="uploaded_ts">1763278440</f>
 *       <f t="pages">12</f>
 *       <t t="artist">Konboi</t>
 *       <t t="group">Group A</t>
 *     </g>
 *     <g><error>1005: Gallery is unavailable or restricted</error></g>
 *   </gmetadata>
 *
 * The `<t>` elements repeat; every other tag appears at most once per `<g>`.
 * Per-item `<error>` entries are preserved so callers can fall back to other
 * metadata sources for that gallery instead of dropping the result.
 */

export interface EhentaiGdataEntry {
  /** The token this `<g>` block was returned for (first `<f t="token">`). */
  token: string | null;
  /** Simple `<f t="...">value</f>` fields. */
  fields: Map<string, string>;
  /** Repeated `<t t="...">value</t>` tag elements, in document order. */
  tags: Array<{ namespace: string; value: string }>;
  /** Present when the API reports this item failed (e.g. unavailable/restricted). */
  error: string | null;
}

const XML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

function decodeXmlText(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = parseInt(entity.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (entity.startsWith('#')) {
      const code = parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return XML_ENTITIES[entity] ?? whole;
  });
}

/** Match one element open tag: `<name attr="value">`. Returns null on mismatch. */
function matchOpenTag(source: string, start: number, name: string): { end: number; attrs: Map<string, string> } | null {
  if (!source.startsWith(`<${name}`, start)) return null;
  let i = start + name.length + 1;
  // Skip the optional closing slash / whitespace.
  const attrs = new Map<string, string>();
  for (;;) {
    while (i < source.length && /\s/.test(source[i])) i++;
    if (i >= source.length) return null;
    if (source[i] === '>') return { end: i + 1, attrs };
    if (source[i] === '/') return null; // self-closing — not expected for our tags
    // Attribute: name="value" or name='value'
    let attrName = '';
    while (i < source.length && /[\w:.-]/.test(source[i])) {
      attrName += source[i];
      i++;
    }
    while (i < source.length && /\s/.test(source[i])) i++;
    if (!attrName || source[i] !== '=') return null;
    i++;
    while (i < source.length && /\s/.test(source[i])) i++;
    const quote = source[i];
    if (quote !== '"' && quote !== "'") return null;
    i++;
    let value = '';
    while (i < source.length && source[i] !== quote) {
      value += source[i];
      i++;
    }
    if (i >= source.length) return null;
    attrs.set(attrName, value);
    i++;
  }
}

/** Parse a gdata XML body. Returns null when the document is not the expected
 *  shape (callers must treat that as a parse failure, not an empty result). */
export function parseEhentaiGdata(xml: string): EhentaiGdataEntry[] | null {
  const docStart = xml.indexOf('<gmetadata');
  if (docStart < 0) return null;
  const closeDoc = xml.indexOf('</gmetadata>');
  if (closeDoc < 0) return null;
  let cursor = docStart + '<gmetadata>'.length;
  const entries: EhentaiGdataEntry[] = [];

  for (;;) {
    // Find the next <g> block strictly before the document close tag.
    let nextEntry = Infinity;
    for (const marker of ['<g>', '<g ']) {
      const idx = xml.indexOf(marker, cursor);
      if (idx >= 0 && idx < nextEntry) nextEntry = idx;
    }
    if (nextEntry > closeDoc) break;
    const open = matchOpenTag(xml, nextEntry, 'g');
    if (!open) return null;
    const entry: EhentaiGdataEntry = { token: null, fields: new Map(), tags: [], error: null };
    let inner = open.end;

    for (;;) {
      const closeG = xml.indexOf('</g>', inner);
      if (closeG < 0) return null; // unbalanced — not a gdata document
      // Find the next element start between inner and closeG.
      let nextEl = inner;
      while (nextEl < closeG) {
        const lt = xml.indexOf('<', nextEl);
        if (lt < 0 || lt > closeG) break;
        if (xml.startsWith('<f ', lt) || xml.startsWith('<t ', lt) || xml.startsWith('<error>', lt)) {
          nextEl = lt;
          break;
        }
        nextEl = lt + 1;
      }
      if (nextEl >= closeG) {
        inner = closeG + 4;
        break;
      }
      if (xml.startsWith('<f ', nextEl)) {
        const openF = matchOpenTag(xml, nextEl, 'f');
        if (!openF) return null;
        const closeF = xml.indexOf('</f>', openF.end);
        if (closeF < 0) return null;
        const t = openF.attrs.get('t');
        if (t) {
          const value = decodeXmlText(xml.slice(openF.end, closeF));
          if (t === 'token' && entry.token === null) entry.token = value;
          entry.fields.set(t, value);
        }
        inner = closeF + 4;
      } else if (xml.startsWith('<t ', nextEl)) {
        const openT = matchOpenTag(xml, nextEl, 't');
        if (!openT) return null;
        const closeT = xml.indexOf('</t>', openT.end);
        if (closeT < 0) return null;
        const namespace = openT.attrs.get('t');
        if (namespace) entry.tags.push({ namespace, value: decodeXmlText(xml.slice(openT.end, closeT)) });
        inner = closeT + 4;
      } else {
        // <error>text</error>
        const closeErr = xml.indexOf('</error>', nextEl);
        if (closeErr < 0) return null;
        entry.error = decodeXmlText(xml.slice(nextEl + '<error>'.length, closeErr));
        inner = closeErr + 8;
      }
    }
    cursor = inner;
    entries.push(entry);
  }
  return entries;
}

/** Extract a numeric field as an integer; null when absent or not integral.
 *  Deliberate: the API returns counts as strings, and unknown/empty values
 *  must not become 0. */
export function gdataNumber(entry: EhentaiGdataEntry, field: string): number | null {
  const raw = entry.fields.get(field);
  if (raw === undefined || raw.trim() === '') return null;
  const value = Number(raw.trim());
  return Number.isInteger(value) && value >= 0 ? value : null;
}
