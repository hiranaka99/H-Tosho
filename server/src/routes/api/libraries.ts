import { Hono } from "hono";
import {
  getLibraryOverride,
  getProviderPriorities,
  setLibraryOverride,
} from "../../services/settings.js";

import { getProvider } from "../../providers/registry.js";
import { intParam } from "./helpers.js";
export const api = new Hono();
api.get("/libraries/:id/override", (c) => {
  const id = intParam(c.req.param("id"));
  if (id === null) return c.json({ error: "Invalid library id" }, 400);
  const ov = getLibraryOverride(id);
  return c.json(
    ov ?? { libraryId: id, priority: getProviderPriorities(), autoMatch: true }
  );
});

api.put("/libraries/:id/override", async (c) => {
  const id = intParam(c.req.param("id"));
  if (id === null) return c.json({ error: "Invalid library id" }, 400);
  // Partial merge: fields omitted from the body keep their current value, so a
  // client can flip a single option without snapshotting the rest.
  const body = (await c.req.json().catch(() => null)) as Partial<{
    priority: unknown;
    autoMatch: unknown;
  }> | null;
  if (!body || typeof body !== "object")
    return c.json({ error: "Provide priority and/or autoMatch" }, 400);
  // Same rule as the global priority list: unique, known providers only.
  if (
    body.priority !== undefined &&
    (!Array.isArray(body.priority) ||
      body.priority.some((p) => typeof p !== "string" || !getProvider(p)) ||
      new Set(body.priority).size !== body.priority.length)
  ) {
    return c.json(
      { error: "priority must contain unique known providers" },
      400
    );
  }
  if (body.autoMatch !== undefined && typeof body.autoMatch !== "boolean")
    return c.json({ error: "autoMatch must be true or false" }, 400);
  const cur = getLibraryOverride(id) ?? {
    libraryId: id,
    priority: getProviderPriorities(),
    autoMatch: true,
  };
  setLibraryOverride({
    libraryId: id,
    priority: (body.priority as string[] | undefined) ?? cur.priority,
    autoMatch: body.autoMatch ?? cur.autoMatch,
  });
  return c.json({ ok: true });
});

// ---------------- Watched searches ----------------
