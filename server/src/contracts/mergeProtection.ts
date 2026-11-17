import type { FieldPolicy, ProtectedField } from './metadata.js';

/** Review hints are verified against authoritative indexed files; they never authorize a write. */
export interface MergeProtectionRequest {
  seriesId?: number;
  sourceSeriesIds?: number[];
  sourceFiles?: string[];
  targetDir?: string;
  seriesName?: string;
}

export interface MergeProtectionSeries extends FieldPolicy {
  seriesId: number;
  libraryId: number;
  name: string;
  role: 'source' | 'target';
  titleChange: boolean;
}

export interface MergeProtectionPreview {
  series: MergeProtectionSeries[];
  inheritedFields: ProtectedField[];
  unassociatedArchives: number;
  canQueue: boolean;
  warnings: string[];
}

/** Server-only, durable evidence saved before a merge can move files or publish downloads. */
export interface MergeProtectionState {
  connectionKey: string;
  sourceSeriesIds: number[];
  targetSeriesId?: number;
  policies: { seriesId: number; revision: number; lockedFields: ProtectedField[] }[];
  inheritedFields: ProtectedField[];
  seriesName: string;
  targetDir: string;
  libraryId?: number;
  archives: {path:string;seriesId?:number}[];
  completedTargetSeriesId?: number;
  identities: {seriesId:number;libraryId:number;folderPath?:string}[];
  rootJobId?: number;
  moves?: {source:string;destination:string;sha256:string;status:'pending'|'published'}[];
}
