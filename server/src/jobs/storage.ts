import {
  parseJobCommand,
  type JobPayload,
  type JobContext,
  type JobExecutionState,
} from "../contracts/jobs.js";
import { isPositiveId, isRecord } from "../lib/guards.js";

export function readStateObject(json: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(json);
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}

export interface JobStateHydration {
  state?: Partial<JobExecutionState>;
  validationError?: string;
}

export type JobStateHydrator = (
  persistedState: Record<string, unknown>,
  rawPayload: Record<string, unknown>
) => JobStateHydration | void;

/** Historical rows stay inspectable, but a malformed command is never made executable by fallback. */
export function readJobPayload(
  type: unknown,
  json: string,
  stateJson = "{}",
  hydrateState?: JobStateHydrator
): { payload: JobPayload; validationError?: string } {
  let raw: Record<string, unknown> = {};
  let objectPayload = false;
  try {
    const parsed: unknown = JSON.parse(json);
    if (isRecord(parsed)) {
      raw = parsed;
      objectPayload = true;
    }
  } catch {
    /* Recorded as a validation failure below. */
  }
  const persistedState = readStateObject(stateJson);
  const state = { ...raw, ...persistedState };
  let payload: JobPayload;
  let validationError: string | undefined;
  try {
    if (!objectPayload) throw new Error("Job payload must be an object");
    payload = parseJobCommand(type, raw).payload;
  } catch (error) {
    validationError = error instanceof Error ? error.message : String(error);
    payload = {
      seriesId: isPositiveId(raw.seriesId) ? raw.seriesId : undefined,
      libraryId: isPositiveId(raw.libraryId) ? raw.libraryId : undefined,
      seriesIds: Array.isArray(raw.seriesIds)
        ? raw.seriesIds.filter(isPositiveId)
        : undefined,
      path: typeof raw.path === "string" ? raw.path : undefined,
    };
  }
  if (isRecord(state.context) && Array.isArray(state.context.series)) {
    const context: JobContext = {
      series: state.context.series.filter(
        (target): target is { id: number; name: string } =>
          isRecord(target) &&
          isPositiveId(target.id) &&
          typeof target.name === "string"
      ),
      libraryId: isPositiveId(state.context.libraryId)
        ? state.context.libraryId
        : undefined,
      libraryName:
        typeof state.context.libraryName === "string"
          ? state.context.libraryName
          : undefined,
    };
    payload.context = context;
  }
  if (Array.isArray(state.contextPendingSeriesIds))
    payload.contextPendingSeriesIds =
      state.contextPendingSeriesIds.filter(isPositiveId);
  const hydrated = hydrateState?.(persistedState, raw);
  if (hydrated?.state) Object.assign(payload, hydrated.state);
  if (hydrated?.validationError) validationError = hydrated.validationError;
  return { payload, validationError };
}
