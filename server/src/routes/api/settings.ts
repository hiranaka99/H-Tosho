import { Hono } from "hono";
import { getProvider } from "../../providers/registry.js";
import {
  getNotificationSettings,
  getPollIntervalHours,
  getProviderPriorities,
  getWatchedSearchIntervalMinutes,
  parseNotificationSettings,
  getProviderSettings,
  setNotificationSettings,
  setPollIntervalHours,
  setProviderPriorities,
  setWatchedSearchIntervalMinutes,
  setProviderSetting,
  getDownloaderSettings,
  parseDownloaderSettings,
  setDownloaderSettings,
  getMatchRefreshIntervalDays,
  setMatchRefreshIntervalDays,
  MAX_MATCH_REFRESH_INTERVAL_DAYS,
  NotificationSettingsConflict,
} from "../../services/settings.js";
import { testNotification } from "../../notify/dispatcher.js";
import {
  getEhentaiAccountView,
  getStoredSession,
  removeEhentaiAccount,
  recordAccess,
  saveEhentaiAccount,
  EhentaiAccountConflict,
  EhentaiAccountCryptoError,
  EhentaiAccountError,
} from "../../services/ehentaiAccount.js";
import {
  parseEhentaiSession,
  parseEhentaiSite,
  type EhentaiSessionInput,
} from "../../contracts/ehentai.js";
import {
  testEhentaiAccess,
  EhentaiUpstreamError,
} from "../../downloader/ehentaiClient.js";
import { RequestAbortedError } from "../../downloader/ehentaiGate.js";

import { CREDENTIAL_FIELDS, errMsg } from "./helpers.js";

/** Map account-service errors to a status + sanitized message. Conflict is
 *  409, input errors 400, and a corrupt key/ciphertext 409 (the client must
 *  reload; silently resetting would destroy the only stored envelope). */
function accountErrorStatus(error: unknown): 400 | 409 {
  return error instanceof EhentaiAccountError &&
    !(error instanceof EhentaiAccountConflict)
    ? 400
    : 409;
}
function accountErrorMessage(error: unknown): string {
  if (error instanceof EhentaiAccountError) return error.message;
  if (error instanceof EhentaiAccountCryptoError) return error.message;
  return "The E-Hentai account could not be updated. Try again.";
}
export const api = new Hono();
api.get("/providers", (c) => {
  const settings = getProviderSettings();
  const out = Object.entries(settings).map(([id, s]) => {
    const p = getProvider(id);
    return {
      id,
      name: p?.name ?? id,
      color: p?.color ?? "#888888",
      helpUrl: p?.helpUrl ?? null,
      supportedTypes: p?.supportedTypes ?? [],
      requiresCredentials: p?.requiresCredentials ?? false,
      providesFields: p?.providesFields ?? [],
      credentialFields: CREDENTIAL_FIELDS[id] ?? [],
      enabled: s.enabled,
      hasCredentials: Object.values(s.credentials).some(
        (v) => v && v.length > 0
      ),
      credentials: s.credentials,
    };
  });
  return c.json(out);
});

api.put("/providers/:id", async (c) => {
  const id = c.req.param("id");
  if (!getProvider(id)) return c.json({ error: "Unknown provider" }, 404);
  const body = (await c.req.json().catch(() => null)) as {
    enabled?: unknown;
    credentials?: unknown;
  } | null;
  if (!body || typeof body !== "object")
    return c.json({ error: "Provide enabled and/or credentials" }, 400);
  if (body.enabled !== undefined && typeof body.enabled !== "boolean")
    return c.json({ error: "enabled must be true or false" }, 400);
  const credentials = body.credentials;
  if (
    credentials !== undefined &&
    (!credentials ||
      typeof credentials !== "object" ||
      Array.isArray(credentials) ||
      Object.values(credentials).some((value) => typeof value !== "string"))
  ) {
    return c.json(
      { error: "credentials must map field names to strings" },
      400
    );
  }
  setProviderSetting(id, {
    enabled: body.enabled,
    credentials: credentials as Record<string, string> | undefined,
  });
  return c.json({ ok: true });
});

api.post("/providers/:id/test", async (c) => {
  const id = c.req.param("id");
  const p = getProvider(id);
  if (!p) return c.json({ error: "Unknown provider" }, 404);
  const s = getProviderSettings()[id];
  try {
    p.setCredentials(s.credentials);
    await p.testConnection();
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ ok: false, error: errMsg(e) });
  }
});

api.get("/settings", (c) => {
  return c.json({
    priorities: getProviderPriorities(),
    notifications: getNotificationSettings(),
    pollIntervalHours: getPollIntervalHours(),
    matchRefreshIntervalDays: getMatchRefreshIntervalDays(),
    watchedSearchIntervalMinutes: getWatchedSearchIntervalMinutes(),
  });
});

api.put("/settings/priorities", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    priorities?: unknown;
  } | null;
  const rawPriorities = body?.priorities;
  if (!Array.isArray(rawPriorities))
    return c.json(
      { error: "priorities must contain unique known providers" },
      400
    );
  const priorities = rawPriorities as unknown[];
  if (
    priorities.some(
      (id): id is string => typeof id !== "string" || !getProvider(id)
    ) ||
    new Set(priorities).size !== priorities.length
  ) {
    return c.json(
      { error: "priorities must contain unique known providers" },
      400
    );
  }
  setProviderPriorities(priorities as string[]);
  return c.json({ ok: true });
});

api.put("/settings/notifications", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    notifications?: unknown;
    expectedRevision?: unknown;
  } | null;
  const parsed = parseNotificationSettings(body?.notifications);
  if (
    !parsed ||
    !Number.isSafeInteger(body?.expectedRevision) ||
    Number(body?.expectedRevision) < 0 ||
    Object.keys(body ?? {}).some(
      (key) => !["notifications", "expectedRevision"].includes(key)
    )
  )
    return c.json(
      { error: "Provide notification settings and expectedRevision." },
      400
    );
  try {
    return c.json({
      ok: true,
      notifications: setNotificationSettings(
        parsed,
        Number(body!.expectedRevision)
      ),
    });
  } catch (error) {
    if (error instanceof NotificationSettingsConflict)
      return c.json({ error: error.message }, 409);
    throw error;
  }
});

api.put("/settings/notifications/test", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    notifications?: unknown;
  } | null;
  const settings = parseNotificationSettings(body?.notifications);
  if (!settings) return c.json({ error: "Invalid notification settings" }, 400);
  return c.json(await testNotification(settings));
});

api.put("/settings/poll-interval", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    hours?: unknown;
  } | null;
  // A malformed body must not silently disable scanning (Number(undefined) || 0).
  const hours =
    typeof body?.hours === "number"
      ? body.hours
      : typeof body?.hours === "string" && body.hours.trim()
        ? Number(body.hours)
        : NaN;
  if (!Number.isFinite(hours) || hours < 0)
    return c.json({ error: "hours must be a non-negative number" }, 400);
  setPollIntervalHours(hours);
  return c.json({ ok: true });
});

api.put("/settings/match-refresh-interval", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    days?: unknown;
  } | null;
  const days =
    typeof body?.days === "number"
      ? body.days
      : typeof body?.days === "string" && body.days.trim()
        ? Number(body.days)
        : NaN;
  if (
    !Number.isInteger(days) ||
    days < 0 ||
    days > MAX_MATCH_REFRESH_INTERVAL_DAYS
  )
    return c.json(
      {
        error: `days must be a whole number from 0 to ${MAX_MATCH_REFRESH_INTERVAL_DAYS}`,
      },
      400
    );
  setMatchRefreshIntervalDays(days);
  return c.json({ ok: true });
});

api.put("/settings/watched-search-interval", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    minutes?: unknown;
  } | null;
  const minutes =
    typeof body?.minutes === "number"
      ? body.minutes
      : typeof body?.minutes === "string" && body.minutes.trim()
        ? Number(body.minutes)
        : NaN;
  if (!Number.isFinite(minutes) || minutes < 0)
    return c.json({ error: "minutes must be a non-negative number" }, 400);
  setWatchedSearchIntervalMinutes(minutes);
  return c.json({ ok: true });
});

// ---------------- Doujinshi downloader ----------------

api.get("/settings/downloader", (c) => c.json(getDownloaderSettings()));

api.put("/settings/downloader", async (c) => {
  const raw = await c.req.json<unknown>().catch(() => null);
  const body =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : null;
  // Older clients omit mappings; preserve saved library access in that case.
  const settings = parseDownloaderSettings(
    body
      ? {
          ...body,
          libraryPathMappings:
            body.libraryPathMappings === undefined
              ? getDownloaderSettings().libraryPathMappings
              : body.libraryPathMappings,
        }
      : raw
  );
  if (!settings) {
    return c.json({ error: "Invalid downloader settings" }, 400);
  }
  setDownloaderSettings(settings);
  return c.json({ ok: true, settings });
});

/** Update library mounts without replacing unrelated downloader settings. */
api.put("/settings/library-path-mappings", async (c) => {
  const body = await c.req
    .json<{ libraryPathMappings?: unknown } | null>()
    .catch(() => null);
  if (!Array.isArray(body?.libraryPathMappings)) {
    return c.json({ error: "Invalid library folder mappings" }, 400);
  }
  const settings = parseDownloaderSettings({
    ...getDownloaderSettings(),
    libraryPathMappings: body.libraryPathMappings,
  });
  if (!settings)
    return c.json({ error: "Invalid library folder mappings" }, 400);
  setDownloaderSettings(settings);
  return c.json({ libraryPathMappings: settings.libraryPathMappings });
});

// ---------------- E-Hentai / ExHentai account ----------------
//
// The account session is stored encrypted in its own record (never in the
// downloader settings JSON) and is write-only: GETs expose flags, access
// evidence, and timestamps, never cookie values. All account responses are
// no-store so credentials and access evidence are not cached.

const EHENTAI_RESPONSE_HEADERS = { "Cache-Control": "private, no-store" };

api.get("/settings/ehentai", (c) => {
  try {
    return c.json(getEhentaiAccountView(), 200, EHENTAI_RESPONSE_HEADERS);
  } catch (error) {
    return c.json(
      { error: accountErrorMessage(error) },
      409,
      EHENTAI_RESPONSE_HEADERS
    );
  }
});

api.put("/settings/ehentai", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    site?: unknown;
    session?: unknown;
    expectedRevision?: unknown;
  } | null;
  if (!body || typeof body !== "object")
    return c.json(
      { error: "Invalid request body" },
      400,
      EHENTAI_RESPONSE_HEADERS
    );
  const unknownKeys = Object.keys(body).some(
    (key) => !["site", "session", "expectedRevision"].includes(key)
  );
  if (unknownKeys)
    return c.json(
      { error: "Unsupported E-Hentai account fields" },
      400,
      EHENTAI_RESPONSE_HEADERS
    );
  const parsedSession = parseEhentaiSession(body.session);
  if (parsedSession.error)
    return c.json(
      { error: parsedSession.error },
      400,
      EHENTAI_RESPONSE_HEADERS
    );
  const parsedSite = parseEhentaiSite(body.site, getEhentaiAccountView().site);
  if (parsedSite.error)
    return c.json({ error: parsedSite.error }, 400, EHENTAI_RESPONSE_HEADERS);
  try {
    const view = saveEhentaiAccount({
      site: parsedSite.site,
      session: parsedSession.session,
      expectedRevision: body.expectedRevision as number,
    });
    return c.json(view, 200, EHENTAI_RESPONSE_HEADERS);
  } catch (error) {
    return c.json(
      { error: accountErrorMessage(error) },
      accountErrorStatus(error),
      EHENTAI_RESPONSE_HEADERS
    );
  }
});

api.post("/settings/ehentai/test", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    mode?: unknown;
    session?: unknown;
  } | null;
  if (
    !body ||
    typeof body !== "object" ||
    (body.mode !== "saved" && body.mode !== "draft")
  ) {
    return c.json(
      { error: 'mode must be "saved" or "draft"' },
      400,
      EHENTAI_RESPONSE_HEADERS
    );
  }
  let session: EhentaiSessionInput | null;
  if (body.mode === "draft") {
    const parsed = parseEhentaiSession(body.session);
    if (parsed.error || !parsed.session)
      return c.json(
        {
          error:
            parsed.error ?? "A complete session is required to test a draft",
        },
        400,
        EHENTAI_RESPONSE_HEADERS
      );
    session = parsed.session;
  } else {
    try {
      session = getStoredSession();
    } catch (error) {
      return c.json(
        { error: accountErrorMessage(error) },
        409,
        EHENTAI_RESPONSE_HEADERS
      );
    }
    if (!session)
      return c.json(
        {
          error: "No saved E-Hentai account. Save one first, or test a draft.",
        },
        400,
        EHENTAI_RESPONSE_HEADERS
      );
  }
  const controller = new AbortController();
  c.req.raw.signal.addEventListener("abort", () => controller.abort(), {
    once: true,
  });
  try {
    const result = await testEhentaiAccess(session, {
      signal: controller.signal,
    });
    // Record timestamped evidence only for the SAVED account; a draft test
    // must not alter the saved account's state (nor save the draft).
    if (body.mode === "saved") {
      recordAccess({
        eHentai: {
          state: result.eHentai.state,
          testedAt: result.testedAt,
          message: result.eHentai.message,
        },
        exHentai: {
          state: result.exHentai.state,
          testedAt: result.testedAt,
          message: result.exHentai.message,
        },
      });
    }
    return c.json(
      {
        eHentai: result.eHentai,
        exHentai: result.exHentai,
        testedAt: result.testedAt,
        saved: body.mode === "saved",
      },
      200,
      EHENTAI_RESPONSE_HEADERS
    );
  } catch (error) {
    if (error instanceof RequestAbortedError)
      return c.json(
        { error: "Request cancelled" },
        400,
        EHENTAI_RESPONSE_HEADERS
      );
    if (error instanceof EhentaiUpstreamError)
      return c.json(
        { error: error.message, kind: error.kind },
        502,
        EHENTAI_RESPONSE_HEADERS
      );
    return c.json({ error: errMsg(error) }, 502, EHENTAI_RESPONSE_HEADERS);
  }
});

api.delete("/settings/ehentai", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    expectedRevision?: unknown;
  } | null;
  try {
    const view = removeEhentaiAccount((body?.expectedRevision ?? 0) as number);
    return c.json(view, 200, EHENTAI_RESPONSE_HEADERS);
  } catch (error) {
    return c.json(
      { error: accountErrorMessage(error) },
      accountErrorStatus(error),
      EHENTAI_RESPONSE_HEADERS
    );
  }
});
