import { recordGalleryIdentity, resolveDuplicateGallery } from '../../services/galleryDuplicates.js';
import { Hono } from 'hono';
import { getDoujinProvider, listDoujinProviders } from '../../downloader/providers.js';
import { rewriteDoujinCover, rewriteDoujinPages } from '../media.js';
import { DOUJIN_SORTS, type DoujinSource, type DoujinSort } from '../../downloader/types.js';

import { errMsg } from './helpers.js';
export const api = new Hono();
api.get('/doujin/providers', (c) => c.json(listDoujinProviders()));

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

/** Autocomplete tag/artist suggestions for a doujinshi source search box. */
api.post('/doujin/suggestions', async (c) => {
  const body = (await c.req.json()) as { source: string; query: string; context?: string };
  if (!body.source || !body.query?.trim()) return c.json({ error: 'source and query are required' }, 400);
  const provider = getDoujinProvider(body.source);
  if (!provider) return c.json({ error: `Unknown source: ${body.source}` }, 400);
  if (typeof provider.suggest !== 'function') return c.json([]);
  try {
    return c.json(await provider.suggest(body.query, 10, typeof body.context === 'string' ? body.context : undefined));
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
