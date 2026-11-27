import type { RestoreFieldAvailability } from "./metadataRestore.js";
import type { CoverHistory } from "./metadataCovers.js";

export interface RecordedValue {
  present: boolean;
  value?: unknown;
  nativeLocked?: boolean;
}
export interface MetadataSnapshot {
  series: {
    id: number;
    libraryId: number;
    name: string | null;
    folderPath?: string | null;
  };
  installationId?: string;
  /** Current title-write capability evidence; never authority for unrelated historical restoration. */
  titleContext?: {
    sortName?: string | null;
    sortNameLocked?: boolean;
    localizedName?: string | null;
    localizedNameLocked?: boolean;
    coverImageLocked?: boolean;
  };
  fields: Record<string, RecordedValue>;
}
export interface MetadataHistoryEntry {
  id: string;
  sequence: number;
  origin: string;
  status: string;
  createdAt: string;
  finishedAt: string | null;
  fields: string[];
  changedFields: string[];
  message: string | null;
  jobId: number | null;
  restoredFromOperationId: string | null;
}
export interface ArchiveHistory {
  id: number;
  target: string;
  status: string;
  beforePresent: boolean;
  afterPresent: boolean | null;
  changes: { field: string; before: RecordedValue; after?: RecordedValue }[];
}
export interface MetadataHistoryDetail extends MetadataHistoryEntry {
  covers?: CoverHistory;
  before: MetadataSnapshot;
  after: MetadataSnapshot | null;
  archives: ArchiveHistory[];
  restoreAvailability: {
    before: RestoreFieldAvailability[];
    after: RestoreFieldAvailability[];
  };
  availability: {
    metadata: string;
    archives: string;
    covers: string;
    restore: string;
  };
}
