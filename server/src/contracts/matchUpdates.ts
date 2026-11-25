/**
 * Pure rules for scheduled refreshes of matched series. A refresh re-reads the
 * exact provider candidate a series is matched to and compares it with the
 * metadata that was last applied. It never searches, so a different or better
 * candidate can never produce an update. No I/O dependencies.
 */
import type { SeriesMetadata } from '../providers/types.js';
import { releaseYear, type ProtectedField } from './metadata.js';

export type MatchUpdateField = ProtectedField | 'volumeCovers';
export interface MatchUpdateChange { field: MatchUpdateField; summary: string }

export interface MatchUpdate {
  seriesId: number;
  name: string;
  libraryId: number | null;
  libraryName: string | null;
  cover: string | null;
  providerId: string;
  providerSeriesId: string;
  /** Provider title and cover, so the review can open on the same candidate. */
  candidateTitle: string;
  candidateCoverUrl: string | null;
  /** Confidence recorded on the existing match (null when unknown). */
  score: number | null;
  changes: MatchUpdateChange[];
  detectedAt: string;
  checkedAt: string;
}

const text = (value: string | undefined | null): string => (value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
const key = (value: string): string => text(value).toLowerCase();
const STATUS_LABELS: Record<string, string> = { ONGOING: 'Ongoing', COMPLETED: 'Completed', HIATUS: 'Hiatus', CANCELLED: 'Cancelled', UNKNOWN: 'Unknown' };
const LIST_LABELS = { genres: ['genre', 'genres'], tags: ['tag', 'tags'], writers: ['writer', 'writers'], artists: ['artist', 'artists'] } as const;

function preview(values: string[]): string {
  return values.length <= 3 ? values.join(', ') : `${values.slice(0, 3).join(', ')} +${values.length - 3} more`;
}

/**
 * What the provider changed since the last apply, excluding protected fields.
 * A value the provider no longer returns is not an update: sync would not push
 * an empty list or title, so only new or different values count. Tags merge
 * additively in Kavita, so only added tags count.
 */
export function diffMatchedMetadata(applied: SeriesMetadata, latest: SeriesMetadata, protectedFields: readonly string[] = []): MatchUpdateChange[] {
  const changes: MatchUpdateChange[] = [];
  const allowed = (field: ProtectedField) => !protectedFields.includes(field);
  // The applied title can be any alternative the user chose, so only a
  // provider title outside every option seen at apply time is new.
  const latestTitle = text(latest.title);
  if (allowed('title') && latestTitle && ![applied.title, ...(applied.titleOptions ?? [])].some(title => key(title) === key(latestTitle))) {
    changes.push({ field: 'title', summary: `Title: ${latestTitle}` });
  }
  if (allowed('summary') && text(latest.summary) && text(latest.summary) !== text(applied.summary)) changes.push({ field: 'summary', summary: 'New description' });
  for (const field of ['genres', 'tags', 'writers', 'artists'] as const) {
    if (!allowed(field)) continue;
    const before = new Set((applied[field] ?? []).map(key).filter(Boolean));
    const now = [...new Map((latest[field] ?? []).map(value => [key(value), text(value)] as const)).entries()].filter(([k]) => k);
    if (!now.length) continue;
    const added = now.filter(([k]) => !before.has(k)).map(([, value]) => value);
    const nowKeys = new Set(now.map(([k]) => k));
    const removed = field === 'tags' ? 0 : [...before].filter(k => !nowKeys.has(k)).length;
    if (!added.length && !removed) continue;
    const [one, many] = LIST_LABELS[field];
    const parts = [added.length ? `${added.length} new ${added.length === 1 ? one : many} (${preview(added)})` : '', removed ? `${removed} removed` : ''].filter(Boolean);
    changes.push({ field, summary: parts.join(' · ').replace(/^./, c => c.toUpperCase()) });
  }
  const year = releaseYear(latest), appliedYear = releaseYear(applied);
  if (allowed('releaseDate') && year !== undefined && year !== appliedYear) changes.push({ field: 'releaseDate', summary: appliedYear === undefined ? `Release year: ${year}` : `Release year: ${appliedYear} → ${year}` });
  if (allowed('language') && text(latest.language) && key(latest.language!) !== key(applied.language ?? '')) changes.push({ field: 'language', summary: `Language: ${text(latest.language)}` });
  if (allowed('status') && latest.status && latest.status !== 'UNKNOWN' && latest.status !== applied.status) {
    changes.push({ field: 'status', summary: applied.status && applied.status !== 'UNKNOWN' ? `Status: ${STATUS_LABELS[applied.status]} → ${STATUS_LABELS[latest.status]}` : `Status: ${STATUS_LABELS[latest.status]}` });
  }
  if (allowed('url') && text(latest.url) && text(latest.url) !== text(applied.url)) changes.push({ field: 'url', summary: 'New provider link' });
  if (allowed('cover')) {
    if (text(latest.coverUrl) && text(latest.coverUrl) !== text(applied.coverUrl)) changes.push({ field: 'cover', summary: 'New cover' });
    const appliedVolumes = new Map((applied.volumeCovers ?? []).map(cover => [cover.number, cover.url]));
    const added = (latest.volumeCovers ?? []).filter(cover => !appliedVolumes.has(cover.number));
    const replaced = (latest.volumeCovers ?? []).filter(cover => appliedVolumes.has(cover.number) && appliedVolumes.get(cover.number) !== cover.url);
    if (added.length) changes.push({ field: 'volumeCovers', summary: `${added.length} new volume ${added.length === 1 ? 'cover' : 'covers'}` });
    else if (replaced.length) changes.push({ field: 'volumeCovers', summary: `${replaced.length} updated volume ${replaced.length === 1 ? 'cover' : 'covers'}` });
  }
  return changes;
}

/** Stable projection of the fields a refresh compares, for fingerprinting one provider state. */
export function matchedMetadataProjection(meta: SeriesMetadata): string {
  const list = (values: string[] | undefined) => [...new Set((values ?? []).map(key).filter(Boolean))].sort();
  return JSON.stringify({
    title: key(meta.title), titleOptions: list(meta.titleOptions), summary: text(meta.summary),
    genres: list(meta.genres), tags: list(meta.tags), writers: list(meta.writers), artists: list(meta.artists),
    year: releaseYear(meta) ?? null, language: key(meta.language ?? ''), status: meta.status ?? null, url: text(meta.url),
    cover: text(meta.coverUrl), volumes: [...(meta.volumeCovers ?? [])].sort((a, b) => a.number - b.number).map(cover => [cover.number, cover.url]),
  });
}
