/** JSON metadata returned by https://api.e-hentai.org/api.php (method=gdata).
 * See https://ehwiki.org/wiki/API. Per-gallery errors remain distinguishable
 * from an invalid response so search can fall back to list-page metadata. */
export interface EhentaiGdataEntry {
  gid: string | null;
  token: string | null;
  fields: Map<string, string>;
  tags: Array<{ namespace: string; value: string }>;
  error: string | null;
}

export function parseEhentaiGdata(body: string): EhentaiGdataEntry[] | null {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object' || !('gmetadata' in data) || !Array.isArray(data.gmetadata)) return null;
  const entries: EhentaiGdataEntry[] = [];
  for (const rawItem of data.gmetadata as unknown[]) {
    if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) return null;
    const item = rawItem as Record<string, unknown>;
    const fields = new Map<string, string>();
    for (const [key, value] of Object.entries(item)) {
      if (typeof value === 'string' || typeof value === 'number') fields.set(key, String(value));
    }
    const tags: EhentaiGdataEntry['tags'] = [];
    if (Array.isArray(item.tags)) {
      for (const tag of item.tags as unknown[]) {
        if (typeof tag !== 'string' || !tag.trim()) continue;
        const colon = tag.indexOf(':');
        tags.push({ namespace: colon >= 0 ? tag.slice(0, colon) : 'other', value: tag.slice(colon + 1) });
      }
    }
    const error = typeof item.error === 'string' ? item.error : null;
    const gid = fields.get('gid') ?? null;
    const token = typeof item.token === 'string' ? item.token.toLowerCase() : null;
    if (!error && (!gid || !token)) return null;
    entries.push({ gid, token, fields, tags, error });
  }
  return entries;
}

/** Counts arrive as strings; absent/empty values must not become zero. */
export function gdataNumber(entry: EhentaiGdataEntry, field: string): number | null {
  const raw = entry.fields.get(field);
  if (raw === undefined || raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}
