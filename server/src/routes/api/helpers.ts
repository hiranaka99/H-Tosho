import { KavitaClient } from "../../kavita/client.js";
import { getKavitaConnection } from "../../services/settings.js";
import {
  jobQueue,
  type JobContext,
  type JobPayload,
} from "../../jobs/queue.js";
import { mapLimit } from "../../lib/http.js";

export const CREDENTIAL_FIELDS: Record<
  string,
  { key: string; label: string }[]
> = {
  myanimelist: [{ key: "clientId", label: "Client ID" }],
};

export function connectedClient(): KavitaClient | null {
  const conn = getKavitaConnection();
  if (!conn.baseUrl || !conn.apiKey) return null;
  return new KavitaClient(conn.baseUrl, conn.apiKey);
}

/** Capture live target identities before execution; outages must not block enqueue. */
export async function resolveJobContext(
  payload: JobPayload,
  client = connectedClient()
): Promise<JobContext | undefined> {
  const context = jobQueue.contextForPayload(payload);
  if (!context) return context;
  const pendingIds = new Set(context.series.map((target) => target.id));
  payload.contextPendingSeriesIds = [...pendingIds];
  if (!client) return context;
  const libraryIds = new Set<number>();
  let resolvedCount = 0;
  const [libraries] = await Promise.all([
    client.getLibraries().catch(() => []),
    mapLimit(context.series, 3, async (target) => {
      try {
        const series = await client.getSeriesById(target.id);
        target.name = series.name;
        libraryIds.add(series.libraryId);
        resolvedCount++;
        pendingIds.delete(target.id);
      } catch {
        // Keep a locally known name, or the explicit Series #id placeholder.
      }
    }),
  ]);
  if (
    context.libraryId === undefined &&
    libraryIds.size === 1 &&
    resolvedCount === context.series.length
  ) {
    context.libraryId = [...libraryIds][0];
  }
  const library = libraries.find((entry) => entry.id === context.libraryId);
  if (library) context.libraryName = library.name;
  payload.contextPendingSeriesIds = [...pendingIds];
  return context;
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
/**
 * Parse an integer route parameter. Returns null for non-integers so callers
 * can answer 400 — a NaN id would otherwise bind as NULL against NOT NULL
 * primary keys and surface as an unhandled 500.
 */
export function intParam(raw: string | undefined): number | null {
  if (!raw || !/^-?\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * Extract searchable strings from stored provider metadata, including fallback
 * tags when a series' Kavita metadata cannot be read.
 */
export function stringsFromMatchMetadata(
  metadataJson: string | null | undefined,
  field: "artists" | "tags" = "artists"
): string[] {
  if (!metadataJson) return [];
  try {
    const meta: unknown = JSON.parse(metadataJson);
    if (meta && typeof meta === "object" && field in meta) {
      const values = (meta as Record<string, unknown>)[field];
      if (Array.isArray(values))
        return values
          .filter(
            (a): a is string => typeof a === "string" && a.trim().length > 0
          )
          .map((value) => value.trim());
    }
  } catch {
    /* corrupt metadata JSON — treat as no values */
  }
  return [];
}

export function kavitaCoverUrl(
  seriesId: number,
  coverImage: string,
  lastSyncedAt?: string | null
): string {
  return `/api/kavita/series/${seriesId}/cover?v=${encodeURIComponent(lastSyncedAt ?? coverImage)}`;
}
