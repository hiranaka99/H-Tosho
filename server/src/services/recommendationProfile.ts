import { desc, eq } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { getDoujinProvider } from '../downloader/providers.js';
import type { DoujinGallery } from '../downloader/types.js';
import type { DoujinSource } from '../contracts/doujin.js';
import type { GalleryTagEntry } from './recommendations.js';
import type { KavitaSeriesSignal } from './recommendationSignals.js';
import { getRecommendationFeedback, normalizeArtist } from './recommendationFeedback.js';
const BACKFILL_LIMIT = 25;

export interface ProfileTerm {
  kind: 'artist' | 'tag' | 'series';
  name: string;
  /** Number of tagged galleries (or owned .cbz, for series) carrying this term. */
  weight: number;
  /** Search namespace observed per source (null = plain keyword). */
  nsBySource: Partial<Record<DoujinSource, string | null>>;
}

export interface TasteProfile {
  terms: ProfileTerm[];
  /** Dominant language of the library, when one covers ≥60% of tagged galleries. */
  language: string | null;
}

function bumpTerm(terms: Map<string, ProfileTerm>, kind: 'artist' | 'tag' | 'series', name: string, source: DoujinSource | null, ns: string | null, weight = 1): void {
  const key = `${kind}:${name.toLowerCase()}`;
  let t = terms.get(key);
  if (!t) {
    t = { kind, name, weight: 0, nsBySource: {} };
    terms.set(key, t);
  }
  t.weight += weight;
  if (source === null) return; // library-scan terms are source-agnostic keywords
  const existing = t.nsBySource[source];
  // Prefer a concrete namespace over a keyword slot once seen.
  if (existing === undefined || (existing === null && ns !== null)) t.nsBySource[source] = ns;
}

function parseEntries(json: string): unknown[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** Aggregate the per-gallery tag rows plus Kavita library signals into a weighted artist/tag/series profile. */
export function buildProfile(signals: KavitaSeriesSignal[]): TasteProfile {
  const rows = getDb().select().from(schema.galleryTags).all();
  const terms = new Map<string, ProfileTerm>();
  const langCounts = new Map<string, number>();
  let taggedWithLang = 0;

  for (const row of rows) {
    const tags = parseEntries(row.tagsJson);
    const artists = parseEntries(row.artistsJson);
    const seenArtists = new Set<string>();
    for (const raw of artists) {
      const name = String(raw ?? '').trim();
      if (!name || seenArtists.has(name.toLowerCase())) continue;
      seenArtists.add(name.toLowerCase());
      bumpTerm(terms, 'artist', name, row.source as DoujinSource, null);
    }
    const seenTags = new Set<string>();
    for (const raw of tags) {
      const entry: GalleryTagEntry = typeof raw === 'string' ? { name: raw, ns: null } : { name: String((raw as GalleryTagEntry)?.name ?? ''), ns: (raw as GalleryTagEntry)?.ns ?? null };
      const name = entry.name.trim();
      if (!name || seenTags.has(name.toLowerCase())) continue;
      seenTags.add(name.toLowerCase());
      bumpTerm(terms, 'tag', name, row.source as DoujinSource, entry.ns);
    }
    const lang = row.language?.trim().toLowerCase();
    if (lang) {
      taggedWithLang += 1;
      langCounts.set(lang, (langCounts.get(lang) ?? 0) + 1);
    }
  }

  // Existing-library signals: ownership is one vote per series. Page count is
  // work length, not preference or engagement, and must not dominate tags from
  // several genuinely distinct owned works.
  for (const sig of signals) {
    const name = sig.name.trim();
    if (!name) continue;
    bumpTerm(terms, 'series', name, null, null);
    const seenTags = new Set<string>();
    for (const tag of sig.tags) {
      const t = tag.trim();
      if (!t || seenTags.has(t.toLowerCase())) continue;
      seenTags.add(t.toLowerCase());
      bumpTerm(terms, 'tag', t, null, null);
    }
    const seenArtists = new Set<string>();
    for (const artist of sig.artists) {
      const a = artist.trim();
      if (!a || seenArtists.has(a.toLowerCase())) continue;
      seenArtists.add(a.toLowerCase());
      bumpTerm(terms, 'artist', a, null, null);
    }
  }

  const feedback = getRecommendationFeedback();
  const muted = new Set(feedback.mutedArtists.map(normalizeArtist));
  for (const item of feedback.liked) {
    // A positive signal strengthens similar work without marking this gallery owned.
    for (const artist of new Set(item.artists)) bumpTerm(terms, 'artist', artist, item.source, 'artist', 3);
    for (const tag of new Set(item.tags)) bumpTerm(terms, 'tag', tag, item.source, null, 2);
  }
  for (const [key, term] of terms) if (term.kind === 'artist' && muted.has(normalizeArtist(term.name))) terms.delete(key);

  let language: string | null = null;
  if (taggedWithLang >= 5) {
    let best: [string, number] | null = null;
    for (const [l, n] of langCounts) if (!best || n > best[1]) best = [l, n];
    if (best && best[1] / taggedWithLang >= 0.6) language = best[0];
  }

  return { terms: [...terms.values()].sort((a, b) => b.weight - a.weight), language };
}


/**
 * Fill in tag data for completed downloads that predate the gallery_tags table
 * (or whose capture failed). Capped per run so the first recommendation pass
 * stays bounded; remaining galleries fill in on later generations.
 */
export async function backfillMissingTags(persistGalleryTags: (source: DoujinSource, gallery: DoujinGallery, invalidate: boolean) => void): Promise<void> {
  const db = getDb();
  // Always inspect a bounded missing batch. A global row-count threshold would
  // strand large legacy libraries forever once any ten galleries were tagged.

  const tagged = new Set(
    db
      .select({ source: schema.galleryTags.source, galleryId: schema.galleryTags.galleryId })
      .from(schema.galleryTags)
      .all()
      .map((r) => `${r.source}:${r.galleryId}`),
  );
  const completed = db
    .select({ source: schema.downloadQueue.source, galleryId: schema.downloadQueue.galleryId })
    .from(schema.downloadQueue)
    .where(eq(schema.downloadQueue.status, 'completed'))
    .orderBy(desc(schema.downloadQueue.id))
    .all();
  const missing = completed.filter((r) => !tagged.has(`${r.source}:${r.galleryId}`)).slice(0, BACKFILL_LIMIT);
  if (!missing.length) return;

  const bySource = new Map<DoujinSource, typeof missing>();
  for (const row of missing) {
    if (row.source !== 'hitomi' && row.source !== 'nhentai') continue;
    const source = row.source;
    const rows = bySource.get(source);
    if (rows) rows.push(row);
    else bySource.set(source, [row]);
  }
  for (const [source, rows] of bySource) {
    const provider = getDoujinProvider(source);
    if (!provider) continue;
    for (let i = 0; i < rows.length; i += 8) {
      await Promise.all(
        rows.slice(i, i + 8).map(async (row) => {
          try {
            const gallery = await provider.getGallery(row.galleryId);
            persistGalleryTags(source, gallery, false);
          } catch {
            /* skip unreachable galleries — they stay untagged until a later pass */
          }
        }),
      );
    }
  }
}
