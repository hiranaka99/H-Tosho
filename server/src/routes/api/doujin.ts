import { recordGalleryIdentity, resolveDuplicateGallery } from '../../services/galleryDuplicates.js';
import { Hono } from 'hono';
import { getDoujinProvider, listDoujinProviders } from '../../downloader/providers.js';
import { getEhentaiAccountView } from '../../services/ehentaiAccount.js';
import { currentPrincipal } from '../../services/auth.js';
import { unifiedSuggestions } from '../../services/unifiedSuggestions.js';
import { runUnifiedSearch, UnifiedQueryError, UnifiedSessionError } from '../../services/unifiedSearch.js';
import { rewriteDoujinCover, rewriteDoujinPages } from '../media.js';
import { DOUJIN_SORTS, type DoujinSort } from '../../downloader/types.js';
import type { DoujinSource } from '../../contracts/doujin.js';

import { errMsg } from './helpers.js';
export const api = new Hono();
api.get('/doujin/providers', (c) => {
  // The E-Hentai entry reflects the saved account's family site (E-Hentai vs
  // ExHentai) so the UI labels and origin follow the user's configuration.
  try {
    return c.json(listDoujinProviders(getEhentaiAccountView().site));
  } catch {
    return c.json(listDoujinProviders());
  }
});

/** Search a doujinshi source by keyword/tag/artist/id-or-url. */
api.post('/doujin/search', async (c) => {
  const body = (await c.req.json()) as { source: string; query: string; sort?: DoujinSort; offset?: number; limit?: number };
  if (!body.source || !body.query?.trim()) return c.json({ error: 'source and query are required' }, 400);
  const provider = getDoujinProvider(body.source);
  if (!provider) return c.json({ error: `Unknown source: ${body.source}` }, 400);
  // Each provider supports its own subset of ordering options.
  // Unknown values fall back to the default ordering.
  const sort: DoujinSort = body.sort && DOUJIN_SORTS.includes(body.sort) ? body.sort : 'default';
  const paged = body.offset !== undefined || body.limit !== undefined;
  if (paged && (!Number.isSafeInteger(body.offset ?? 0) || (body.offset ?? 0) < 0
    || !Number.isSafeInteger(body.limit ?? 25) || (body.limit ?? 25) < 1 || (body.limit ?? 25) > 100)) {
    return c.json({ error: 'offset must be nonnegative and limit must be between 1 and 100' }, 400);
  }
  try {
    if (paged && provider.searchPage) {
      const page = await provider.searchPage(body.query, body.offset ?? 0, body.limit ?? 25, sort);
      return c.json({ ...page, items: page.items.map(rewriteDoujinCover) });
    }
    // Request the full result set (both providers cap internally at ~1000).
    const results = await provider.search(body.query, 1000, sort);
    if (paged) return c.json({ items: results.slice(body.offset ?? 0, (body.offset ?? 0) + (body.limit ?? 25)).map(rewriteDoujinCover), total: results.length });
    // Route hitomi covers through the /media proxy so they carry the Referer
    // their CDN requires (browsers can't send it cross-origin).
    return c.json(results.map(rewriteDoujinCover));
  } catch (e) {
    return c.json({ error: errMsg(e) }, 502);
  }
});

/** Unified search across all doujinshi sources with bounded per-source lanes.
 *  Body: { query } to start, or { cursor, retry? } to continue a session.
 *  Responses are cached per cursor server-side; repeat the last cursor to
 *  replay its page. */
api.post('/doujin/search/unified', async (c) => {
  const body = (await c.req.json().catch(() => null)) as
    | { query?: string; cursor?: string; retry?: string; limit?: number }
    | null;
  if (!body || typeof body !== 'object') return c.json({ error: 'Invalid request body' }, 400);
  const limit = body.limit === undefined ? undefined : body.limit;
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 50)) {
    return c.json({ error: 'limit must be between 1 and 50' }, 400);
  }
  if (body.cursor && body.query) return c.json({ error: 'Send either a new query or a continuation cursor, not both' }, 400);
  if (!body.cursor && !body.query?.trim()) return c.json({ error: 'query is required' }, 400);
  const controller = new AbortController();
  c.req.raw.signal.addEventListener('abort', () => controller.abort(), { once: true });
  try {
    const page = await runUnifiedSearch(
      {
        query: body.query,
        cursor: body.cursor,
        retry: typeof body.retry === 'string' ? body.retry : undefined,
        limit,
        principal: currentPrincipal(c),
      },
      controller.signal,
    );
    return c.json(page, 200, { 'Cache-Control': 'private, no-store' });
  } catch (e) {
    if (e instanceof UnifiedQueryError) return c.json({ error: e.message }, 400);
    if (e instanceof UnifiedSessionError) {
      return c.json({ error: e.message, kind: e.kind }, e.kind === 'expired' || e.kind === 'stale' ? 410 : 409);
    }
    return c.json({ error: errMsg(e) }, 502);
  }
});

/** Autocomplete tag/artist suggestions for a doujinshi source search box. */
api.post('/doujin/suggestions', async (c) => {
  const body = (await c.req.json()) as { source: string; query: string; context?: string };
  if (!body.source || !body.query?.trim()) return c.json({ error: 'source and query are required' }, 400);
  if (body.source === 'unified') return c.json(await unifiedSuggestions(body.query, 10, c.req.raw.signal));
  const provider = getDoujinProvider(body.source);
  if (!provider) return c.json({ error: `Unknown source: ${body.source}` }, 400);
  if (typeof provider.suggest !== 'function') return c.json([]);
  try {
    return c.json(await provider.suggest(body.query, 10, typeof body.context === 'string' ? body.context : undefined, c.req.raw.signal));
  } catch (e) {
    return c.json({ error: errMsg(e) }, 502);
  }
});

/** Resolve full gallery metadata + image list (for preview / page count). */
api.post('/doujin/gallery', async (c) => {
  const body = (await c.req.json()) as { source: string; idOrUrl: string };
  if (!body.source || !body.idOrUrl?.trim()) return c.json({ error: 'source and idOrUrl are required' }, 400);
  const provider = getDoujinProvider(body.source);
  if (!provider) return c.json({ error: `Unknown source: ${body.source}` }, 400);
  try {
    // Page URLs stay behind the authenticated, allowlisted media proxy so the
    // browser never needs provider-specific Referer headers or direct CDN access.
    const gallery = await resolveDuplicateGallery(body.source as DoujinSource, body.idOrUrl);
    recordGalleryIdentity(gallery);
    const { pages, pageFallbacks, requestHeaders: _requestHeaders, resolvePageUrl: _resolvePageUrl, ...meta } = gallery;
    return c.json({ ...rewriteDoujinCover(meta), ...rewriteDoujinPages(pages, pageFallbacks), pageCount: pages.length });
  } catch (e) {
    return c.json({ error: errMsg(e) }, 502);
  }
});

/** Resolve authoritative metadata and compare against ownership, active work, and local CBZ files. */
