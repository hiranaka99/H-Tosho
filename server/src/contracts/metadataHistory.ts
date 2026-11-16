export interface RecordedValue { present: boolean; value?: unknown; nativeLocked?: boolean }
export interface MetadataSnapshot { series: { id: number; libraryId: number; name: string | null }; fields: Record<string, RecordedValue> }
export interface MetadataHistoryEntry {
  id: string; sequence: number; origin: string; status: string; createdAt: string; finishedAt: string | null;
  fields: string[]; changedFields: string[]; message: string | null; jobId: number | null;
}
export interface ArchiveHistory {
  target: string; status: string;
  beforePresent: boolean; afterPresent: boolean | null;
  changes: { field: string; before: RecordedValue; after?: RecordedValue }[];
}
export interface MetadataHistoryDetail extends MetadataHistoryEntry {
  before: MetadataSnapshot; after: MetadataSnapshot | null;
  archives: ArchiveHistory[];
  availability: { metadata: string; archives: string; covers: string; restore: string };
}
