import { parseJobCommand, type JobPayload, type JobContext } from '../contracts/jobs.js';
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const id = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
function readObject(json: string): Record<string, unknown> {
  try { const value: unknown = JSON.parse(json); return record(value) ? value : {}; }
  catch { return {}; }
}

/** Historical rows stay inspectable, but a malformed command is never made executable by fallback. */
export function readJobPayload(type: unknown, json: string, stateJson = '{}'): { payload: JobPayload; validationError?: string } {
  const raw = readObject(json), state = { ...raw, ...readObject(stateJson) };
  let objectPayload = false;
  try { objectPayload = record(JSON.parse(json)); } catch { /* Recorded as a validation failure below. */ }
  let payload: JobPayload;
  let validationError: string | undefined;
  try {
    if (!objectPayload) throw new Error('Job payload must be an object');
    payload = parseJobCommand(type, raw).payload;
  }
  catch (error) {
    validationError = error instanceof Error ? error.message : String(error);
    payload = { seriesId: id(raw.seriesId) ? raw.seriesId : undefined, libraryId: id(raw.libraryId) ? raw.libraryId : undefined,
      seriesIds: Array.isArray(raw.seriesIds) ? raw.seriesIds.filter(id) : undefined, path: typeof raw.path === 'string' ? raw.path : undefined };
  }
  if (record(state.context) && Array.isArray(state.context.series)) {
    const context: JobContext = { series: state.context.series.filter((target): target is { id: number; name: string } => record(target) && id(target.id) && typeof target.name === 'string'),
      libraryId: id(state.context.libraryId) ? state.context.libraryId : undefined,
      libraryName: typeof state.context.libraryName === 'string' ? state.context.libraryName : undefined };
    payload.context = context;
  }
  if (Array.isArray(state.contextPendingSeriesIds)) payload.contextPendingSeriesIds = state.contextPendingSeriesIds.filter(id);
  if (record(state.mergeDownloadIds)) payload.mergeDownloadIds = Object.fromEntries(Object.entries(state.mergeDownloadIds).filter((entry): entry is [string, number] => id(entry[1])));
  if (record(state.chapters) && Object.values(state.chapters).every(value => typeof value === 'string')) payload.chapters = state.chapters as Record<string, string>;
  if (Array.isArray(state.sourceFiles) && state.sourceFiles.every(value => typeof value === 'string')) payload.sourceFiles = state.sourceFiles;
  return { payload, validationError };
}
