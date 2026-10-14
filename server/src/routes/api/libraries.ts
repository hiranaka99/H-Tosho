import { Hono } from 'hono';
import { getLibraryOverride, getProviderPriorities, setLibraryOverride } from '../../services/settings.js';

import { intParam } from './helpers.js';
export const api = new Hono();
api.get('/libraries/:id/override', (c) => {
  const id = intParam(c.req.param('id'));
  if (id === null) return c.json({ error: 'Invalid library id' }, 400);
  const ov = getLibraryOverride(id);
  return c.json(ov ?? { libraryId: id, priority: getProviderPriorities(), autoMatch: true });
});

api.put('/libraries/:id/override', async (c) => {
  const id = intParam(c.req.param('id'));
  if (id === null) return c.json({ error: 'Invalid library id' }, 400);
  // Partial merge: fields omitted from the body keep their current value, so a
  // client can flip a single option without snapshotting the rest.
  const body = (await c.req.json()) as Partial<{ priority: string[]; autoMatch: boolean }>;
  const cur = getLibraryOverride(id) ?? { libraryId: id, priority: getProviderPriorities(), autoMatch: true };
  setLibraryOverride({
    libraryId: id,
    priority: body.priority ?? cur.priority,
    autoMatch: body.autoMatch ?? cur.autoMatch });
  return c.json({ ok: true });
});

// ---------------- Watched searches ----------------
