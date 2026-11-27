import { recordGalleryIdentity, resolveDuplicateGallery } from '../../services/galleryDuplicates.js';
import { Hono } from 'hono';
import { getDoujinProvider, listDoujinProviders } from '../../downloader/providers.js';
import { getEhentaiAccountSite } from '../../services/ehentaiAccount.js';
import { currentPrincipal } from '../../services/auth.js';
import { unifiedSuggestions } from '../../services/unifiedSuggestions.js';
import { runUnifiedSearch, UnifiedQueryError, UnifiedSessionError } from '../../services/unifiedSearch.js';
import { rewriteDoujinCover, rewriteDoujinPages } from '../media.js';
import { DOUJIN_SORTS, type DoujinSort } from '../../downloader/types.js';
import type { DoujinSource, UnifiedSearchStreamEvent } from '../../contracts/doujin.js';

import { errMsg } from './helpers.js';
export const api = new Hono();
api.get('/doujin/providers', (c) => {
  // The E-Hentai entry reflects the saved account's family site (E-Hentai vs
  // ExHentai) so the UI labels and origin follow the user's configuration.
  try {
    return c.json(listDoujinProviders(getEhentaiAccountSite()));
  } catch {
    return c.json(listDoujinProviders());
  }
});

/** Search a doujinshi source by keyword/tag/artist/id-or-url. */
api.post('/doujin/search', async (c) => {
  const body = await c.req.json<{ source: string; query: string; sort?: DoujinSort; offset?: number; limit?: number } | null>();
  if (!body || typeof body.source !== 'string' || !body.source || typeof body.query !== 'string' || !body.query.trim()) return c.json({ error: 'source and query are required' }, 400);
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

/** Status and body for a unified-search failure. */
function unifiedError(e: unknown): { status: 400 | 409 | 410 | 502; body: { error: string; kind?: string } } {
  if (e instanceof UnifiedQueryError) return { status: 400, body: { error: e.message } };
  if (e instanceof UnifiedSessionError) {
    return { status: e.kind === 'expired' || e.kind === 'stale' ? 410 : 409, body: { error: e.message, kind: e.kind } };
  }
  return { status: 502, body: { error: errMsg(e) } };
}

/** Unified search across all doujinshi sources with bounded per-source lanes.
 *  Body: { query } to start, or { cursor, retry? } to continue a session.
 *  Responses are cached per cursor server-side; repeat the last cursor to
 *  replay its page.
 *
 *  `stream: true` on a new query answers with NDJSON UnifiedSearchStreamEvent
 *  lines, so each provider's results show as soon as it answers. The status
 *  line waits for the first event: errors raised before any progress (bad
 *  query, URL lookups) keep their plain JSON error response, and a search
 *  that never reports progress is answered as a plain JSON page. */
api.post('/doujin/search/unified', async (c) => {
  const body = (await c.req.json().catch(() => null)) as
    | { query?: string; cursor?: string; retry?: string; limit?: number; stream?: boolean }
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
  const req = {
    query: body.query,
    cursor: body.cursor,
    retry: typeof body.retry === 'string' ? body.retry : undefined,
    limit,
    principal: currentPrincipal(c),
  };

  if (body.stream === true && !body.cursor) {
    const encoder = new TextEncoder();
    const pending: Uint8Array[] = [];
    let sink: ReadableStreamDefaultController<Uint8Array> | null = null;
    let closed = false;
    const write = (event: UnifiedSearchStreamEvent) => {
      if (closed) return;
      const chunk = encoder.encode(`${JSON.stringify(event)}\n`);
      if (sink) sink.enqueue(chunk);
      else pending.push(chunk);
    };
    let progressed!: () => void;
    const firstProgress = new Promise<'progress'>((resolve) => { progressed = () => resolve('progress'); });
    const work = runUnifiedSearch(req, controller.signal, (progress) => {
      write({ type: 'progress', ...progress });
      progressed();
    });
    const first = await Promise.race([firstProgress, work.then(() => 'settled' as const, () => 'settled' as const)]);
    if (first === 'settled' && !pending.length) {
      try {
        return c.json(await work, 200, { 'Cache-Control': 'private, no-store' });
      } catch (e) {
        const { status, body: errorBody } = unifiedError(e);
        return c.json(errorBody, status);
      }
    }
    const stream = new ReadableStream<Uint8Array>({
      start(controllerRef) {
        sink = controllerRef;
        for (const chunk of pending.splice(0)) controllerRef.enqueue(chunk);
        void work.then(
          (page) => write({ type: 'page', page }),
          (e) => {
            const { status, body: errorBody } = unifiedError(e);
            write({ type: 'error', error: errorBody.error, status, ...(errorBody.kind ? { kind: errorBody.kind } : {}) });
          },
        ).finally(() => {
          closed = true;
          try { controllerRef.close(); } catch { /* reader already gone */ }
        });
      },
      cancel() {
        closed = true;
        controller.abort();
      },
    });
    // no-transform keeps compression and proxies from buffering the events.
    return new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'private, no-store, no-transform', 'X-Accel-Buffering': 'no' },
    });
  }

  try {
    const page = await runUnifiedSearch(req, controller.signal);
    return c.json(page, 200, { 'Cache-Control': 'private, no-store' });
  } catch (e) {
    const { status, body: errorBody } = unifiedError(e);
    return c.json(errorBody, status);
  }
});

/** Autocomplete tag/artist suggestions for a doujinshi source search box. */
api.post('/doujin/suggestions', async (c) => {
  const body = await c.req.json<{ source: string; query: string; context?: string } | null>();
  if (!body || typeof body.source !== 'string' || !body.source || typeof body.query !== 'string' || !body.query.trim()) return c.json({ error: 'source and query are required' }, 400);
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
  const body = await c.req.json<{ source: string; idOrUrl: string } | null>();
  if (!body || typeof body.source !== 'string' || !body.source || typeof body.idOrUrl !== 'string' || !body.idOrUrl.trim()) return c.json({ error: 'source and idOrUrl are required' }, 400);
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
